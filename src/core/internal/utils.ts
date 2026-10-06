import { createHash } from "node:crypto";
import { matchesGlob } from "node:path";

export const VERSION = "0.0.0";
export const DEFAULT_WEIGHTS = { blocker: 15, error: 8, warn: 3, info: 1 };

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function nativeMatch(value: string, pattern: string): boolean {
  if (matchesGlob(value, pattern)) return true;
  return value === pattern || value.includes(pattern);
}

/** Offsets of a script node (`start`/`end` or `range`) or a template node (`loc`). */
export function nodeOffsets(node: unknown): { start: number; end: number } | undefined {
  const value = node as {
    start?: number;
    end?: number;
    range?: [number, number];
    loc?: { start?: { offset?: number }; end?: { offset?: number } };
  };
  const start = value.start ?? value.range?.[0] ?? value.loc?.start?.offset;
  if (typeof start !== "number") return undefined;
  const end = value.end ?? value.range?.[1] ?? value.loc?.end?.offset ?? start;
  return { start, end };
}
