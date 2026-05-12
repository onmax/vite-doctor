import { createError, defineEventHandler, getQuery, getRouterParam, setHeader } from "h3";

const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const REF_RE = /^[A-Za-z0-9_./-]+$/;
const MAX_TARBALL_BYTES = 25 * 1024 * 1024;

export default defineEventHandler(async (event) => {
  const owner = getRouterParam(event, "owner");
  const repo = getRouterParam(event, "repo");
  const refQuery = getQuery(event).ref;
  const ref = typeof refQuery === "string" && refQuery ? refQuery : "HEAD";

  if (!owner || !repo || !NAME_RE.test(owner) || !NAME_RE.test(repo) || !REF_RE.test(ref)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid GitHub repository reference" });
  }

  const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`;
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: {
      Accept: "application/x-gzip, application/octet-stream",
      "User-Agent": "nuxt-doctor-docs",
    },
    signal: controller.signal,
  });

  if (response.status === 404) {
    throw createError({ statusCode: 404, statusMessage: "Repo not found or private" });
  }

  if (!response.ok || !response.body) {
    throw createError({
      statusCode: response.status || 502,
      statusMessage: `GitHub tarball fetch failed: ${response.status}`,
    });
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_TARBALL_BYTES) {
    controller.abort();
    throw createError({ statusCode: 413, statusMessage: "GitHub tarball is too large" });
  }

  const body = await readLimited(response.body, MAX_TARBALL_BYTES, controller);

  setHeader(event, "Content-Type", "application/gzip");
  setHeader(event, "Content-Length", String(body.byteLength));
  setHeader(event, "Cache-Control", "public, max-age=300, s-maxage=3600");

  return body;
});

async function readLimited(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  controller: AbortController,
) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        controller.abort();
        throw createError({ statusCode: 413, statusMessage: "GitHub tarball is too large" });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
