import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vite-plus/test";
import { runViteDoctor } from "../../src/doctor.ts";

test.each([
  { name: "string", bin: "bin/command.js", entry: "bin/command.js" },
  { name: "command map", bin: { command: "bin/command.js" }, entry: "bin/command.js" },
  { name: "built TypeScript", bin: { command: "dist/command.mjs" }, entry: "src/command.ts" },
  { name: "workspace package", bin: "bin/command.js", entry: "bin/command.js", nested: true },
])("keeps the $name package bin and its side effects reachable", async ({ bin, entry, nested }) => {
  const root = await mkdtemp(join(tmpdir(), "doctor-bin-entry-"));
  const packageRoot = nested ? join(root, "packages/tool") : root;
  try {
    await mkdir(packageRoot, { recursive: true });
    if (nested) await writeFile(join(root, "package.json"), '{"private":true}');
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "example-tool", type: "module", bin }),
    );
    await mkdir(dirname(join(packageRoot, entry)), { recursive: true });
    await writeFile(join(packageRoot, entry), '#!/usr/bin/env node\nimport "./effect.js";\n');
    await writeFile(join(packageRoot, dirname(entry), "effect.js"), 'console.log("command");\n');
    await writeFile(join(packageRoot, dirname(entry), "unused.js"), 'console.log("unused");\n');

    const result = await runViteDoctor({ root, analyses: "dead-code", cache: false });
    expect(
      result.diagnostics
        .filter((item) => item.ruleId === "workspace/dead-code/unused-file")
        .map((item) => item.file),
    ).toEqual([join(packageRoot, dirname(entry), "unused.js")]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a bin directory without package metadata does not make every file an entrypoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-bin-control-"));
  try {
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "package.json"), '{"name":"example-tool","bin":{"tool":null}}');
    await writeFile(join(root, "bin/unused.js"), 'console.log("unused");\n');
    const result = await runViteDoctor({ root, analyses: "dead-code", cache: false });
    expect(
      result.diagnostics
        .filter((item) => item.ruleId === "workspace/dead-code/unused-file")
        .map((item) => item.file),
    ).toEqual([join(root, "bin/unused.js")]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
