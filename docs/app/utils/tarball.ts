import { parseTar } from "nanotar";
import type { FileSystemTree } from "@webcontainer/api";
import type { GhRef } from "./parseGhUrl.js";

export class PrivateOrMissingError extends Error {
  constructor() {
    super("Repo not found or private");
    this.name = "PrivateOrMissingError";
  }
}

export class TarballTooLargeError extends Error {
  constructor(public bytes: number) {
    super(`Repo too big (${(bytes / 1024 / 1024).toFixed(1)} MB) — scan locally`);
    this.name = "TarballTooLargeError";
  }
}

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 5000;
const SKIP_DIR = /(^|\/)(node_modules|\.git|dist|\.next|\.nuxt|\.output|coverage)(\/|$)/;

export async function fetchAndUnpackTarball(ref: GhRef): Promise<FileSystemTree> {
  const url = `/api/github-tarball/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}?ref=${encodeURIComponent(ref.ref)}`;
  const res = await fetch(url);
  if (res.status === 404) throw new PrivateOrMissingError();
  if (res.status === 413) throw new TarballTooLargeError(MAX_BYTES);
  if (!res.ok || !res.body) throw new Error(`Fetch failed: ${res.status}`);

  const decompressed = res.body.pipeThrough(new DecompressionStream("gzip"));
  const buffer = await readLimited(decompressed, MAX_BYTES);

  const entries = parseTar(new Uint8Array(buffer));
  const tree: FileSystemTree = {};
  let count = 0;
  for (const entry of entries) {
    if (entry.type !== "file" || !entry.data) continue;
    const path = entry.name.replace(/^[^/]+\//, "");
    if (!path || SKIP_DIR.test(path)) continue;
    if (++count > MAX_FILES) throw new TarballTooLargeError(buffer.byteLength);
    insert(tree, path, entry.data);
  }
  return tree;
}

async function readLimited(stream: ReadableStream<Uint8Array>, maxBytes: number) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new TarballTooLargeError(total);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

function insert(tree: FileSystemTree, path: string, data: Uint8Array) {
  const parts = path.split("/");
  let node = tree;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (!node[part]) node[part] = { directory: {} };
    const child = node[part]! as { directory: FileSystemTree };
    if (!("directory" in child)) return;
    node = child.directory;
  }
  const name = parts[parts.length - 1]!;
  node[name] = { file: { contents: data } };
}
