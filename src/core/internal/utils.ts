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
