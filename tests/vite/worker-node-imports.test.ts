import { describe, expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../src/core/testkit.ts";
import { noNodeApiInWorker } from "../../src/rules.ts";

describe("browser worker Node imports", () => {
  test.each([
    'import type { Stats } from "node:fs"',
    'import type * as fs from "fs"',
    'import fs from "fs-extra"',
    'import assert from "assertion-library"',
  ])("allows erased type imports and non-builtin packages: %s", async (source) => {
    const result = await runRuleFixture({
      rule: noNodeApiInWorker,
      framework: "vite",
      files: { "src/task.worker.ts": source },
    });
    expect(result.diagnostics).toEqual([]);
  });

  test.each([
    'import { readFile } from "fs/promises"',
    'import { ReadableStream } from "stream/web"',
    'import { Buffer } from "buffer"',
    'import { fileURLToPath } from "url"',
    'import { createRequire } from "module"',
    'import { type Stats, readFile } from "node:fs"',
    'import { type Stats, type Dirent } from "node:fs"',
    'import { type Stats } from "fs"',
    'import "node:fs"',
    'import {} from "fs"',
  ])("reports runtime Node builtin imports: %s", async (source) => {
    const result = await runRuleFixture({
      rule: noNodeApiInWorker,
      framework: "vite",
      files: {
        "src/task.worker.ts": source,
        "tsconfig.json": JSON.stringify({ compilerOptions: { verbatimModuleSyntax: true } }),
      },
    });
    expect(result.diagnostics.map(({ code }) => code)).toEqual(["VITE0020"]);
  });
});
