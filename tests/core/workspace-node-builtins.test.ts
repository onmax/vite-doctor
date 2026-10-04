import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { runViteDoctor } from "../../src/doctor.ts";

async function unlistedImports(specifiers: string[]) {
  const root = mkdtempSync(join(tmpdir(), "doctor-node-builtins-"));
  try {
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "src/main.js"),
      specifiers.map((name) => `import ${JSON.stringify(name)};`).join("\n"),
    );
    const result = await runViteDoctor({
      root,
      framework: "vite",
      analyses: "dead-code",
      cache: false,
    });
    return result.diagnostics
      .filter((d) => d.ruleId === "workspace/dead-code/unlisted-dependency")
      .map((d) => d.message);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test.each([
  "http",
  "https",
  "assert/strict",
  "timers/promises",
  "child_process",
  "worker_threads",
  "perf_hooks",
  "zlib",
  "fs/promises",
  "node:test/reporters",
])("Node builtin %s does not need a package dependency", async (specifier) => {
  expect(await unlistedImports([specifier])).toEqual([]);
});

test("similarly named packages still require dependency declarations", async () => {
  expect(await unlistedImports(["http-client", "timers-extra", "@example/assert/strict"])).toEqual([
    'Package "http-client" is imported but is not listed in package.json dependencies.',
    'Package "timers-extra" is imported but is not listed in package.json dependencies.',
    'Package "@example/assert" is imported but is not listed in package.json dependencies.',
  ]);
});

test("invalid builtin subpaths still require dependency declarations", async () => {
  expect(await unlistedImports(["assert/strict", "assert/custom", "http", "http/custom"])).toEqual([
    'Package "assert" is imported but is not listed in package.json dependencies.',
    'Package "http" is imported but is not listed in package.json dependencies.',
  ]);
});
