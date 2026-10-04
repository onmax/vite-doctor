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

test.each([false, true])(
  "keeps declared executable directories reachable (nested package: %s)",
  async (nested) => {
    const root = await mkdtemp(join(tmpdir(), "doctor-bin-directory-"));
    const packageRoot = nested ? join(root, "packages/tool") : root;
    try {
      await mkdir(join(packageRoot, "commands/nested"), { recursive: true });
      if (nested) await writeFile(join(root, "package.json"), '{"private":true}');
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify({ name: "example-tool", directories: { bin: "commands" } }),
      );
      await writeFile(join(packageRoot, "commands/first.js"), 'import "../effect.js";\n');
      await writeFile(join(packageRoot, "commands/nested/second.js"), 'console.log("second");\n');
      await writeFile(join(packageRoot, "effect.js"), 'console.log("effect");\n');
      await writeFile(join(packageRoot, "unused.js"), 'console.log("unused");\n');
      const result = await runViteDoctor({ root, analyses: "dead-code", cache: false });
      expect(
        result.diagnostics
          .filter((item) => item.ruleId === "workspace/dead-code/unused-file")
          .map((item) => item.file),
      ).toEqual([join(packageRoot, "unused.js")]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each([
  { directories: { bin: "missing" } },
  { directories: { bin: "" } },
  { directories: { bin: 42 } },
  { bin: { tool: "command.js" }, directories: { bin: "commands" } },
])("ignores unavailable or overridden executable directories: %j", async (metadata) => {
  const root = await mkdtemp(join(tmpdir(), "doctor-bin-directory-control-"));
  try {
    await mkdir(join(root, "commands"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "example-tool", ...metadata }),
    );
    await writeFile(join(root, "command.js"), 'import "./effect.js";\n');
    await writeFile(join(root, "effect.js"), 'console.log("effect");\n');
    await writeFile(join(root, "commands/unused.js"), 'console.log("unused");\n');
    const result = await runViteDoctor({ root, analyses: "dead-code", cache: false });
    const unused = result.diagnostics
      .filter((item) => item.ruleId === "workspace/dead-code/unused-file")
      .map((item) => item.file);
    expect(unused).toContain(join(root, "commands/unused.js"));
    if ("bin" in metadata) {
      expect(unused).toEqual([join(root, "commands/unused.js")]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
