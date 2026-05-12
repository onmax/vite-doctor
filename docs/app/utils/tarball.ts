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

  const tree: FileSystemTree = {};
  let count = 0;
  for (const entry of parseTarFiles(new Uint8Array(buffer))) {
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

function parseTarFiles(bytes: Uint8Array): Array<{ name: string; data: Uint8Array }> {
  const entries: Array<{ name: string; data: Uint8Array }> = [];
  let offset = 0;

  while (offset + 512 <= bytes.length && !isEmptyBlock(bytes, offset)) {
    const header = bytes.subarray(offset, offset + 512);
    const type = String.fromCharCode(header[156] ?? 0);
    const size = readTarOctal(header, 124, 12);
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;

    if ((type === "0" || type === "\0") && fullName && dataEnd <= bytes.length) {
      entries.push({ name: fullName, data: bytes.slice(dataStart, dataEnd) });
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  return entries;
}

function readTarOctal(bytes: Uint8Array, offset: number, length: number): number {
  const raw = readTarString(bytes, offset, length).trim();
  return raw ? Number.parseInt(raw, 8) : 0;
}

function readTarString(bytes: Uint8Array, offset: number, length: number): string {
  let end = offset;
  const max = offset + length;
  while (end < max && bytes[end] !== 0) end += 1;
  return new TextDecoder().decode(bytes.subarray(offset, end));
}

function isEmptyBlock(bytes: Uint8Array, offset: number): boolean {
  for (let index = offset; index < offset + 512; index += 1) {
    if (bytes[index] !== 0) return false;
  }
  return true;
}
