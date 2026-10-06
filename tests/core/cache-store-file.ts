import { readFileSync, writeFileSync } from "node:fs";

/** The two lines of a Doctor cache store: the index and the File Facts section. */
export interface StoreFile {
  index: {
    version: number;
    engine: string;
    writtenAt: number;
    ruleKeys: string[];
    ruleSets: number[][];
    inputs: Array<[string, string]>;
    signatures: Record<string, [number, number, number, number, number, string]>;
    files: Record<
      string,
      { hash: string; shape: number; gaps?: unknown[]; rs?: number; r?: Record<string, unknown> }
    >;
    runs: Record<string, unknown>;
    graph?: unknown;
    lastWrite?: Record<string, unknown>;
  };
  facts: Record<string, Record<string, unknown>>;
}

export function readStoreFile(path: string): StoreFile {
  const text = readFileSync(path, "utf8");
  const newline = text.indexOf("\n");
  return { index: JSON.parse(text.slice(0, newline)), facts: JSON.parse(text.slice(newline + 1)) };
}

export function writeStoreFile(path: string, store: StoreFile): void {
  writeFileSync(path, `${JSON.stringify(store.index)}\n${JSON.stringify(store.facts)}`);
}
