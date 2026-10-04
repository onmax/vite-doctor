import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { expect, test } from "vite-plus/test";
import { runViteDoctor } from "../../src/doctor.ts";

async function diagnose(files: Record<string, string>, analyses = "dead-code") {
  const root = mkdtempSync(join(tmpdir(), "doctor-ts-imports-"));
  try {
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    const result = await runViteDoctor({ root, framework: "vite", analyses, cache: false });
    return result.diagnostics.map((item) => ({
      rule: item.ruleId,
      file: item.file.slice(root.length + 1),
      message: item.message,
    }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test.each([
  ["js", "ts"],
  ["js", "tsx"],
  ["jsx", "tsx"],
  ["mjs", "mts"],
  ["cjs", "cts"],
])("resolves .%s imports to authored .%s source", async (output, source) => {
  const findings = await diagnose({
    "src/main.ts": `import { value } from './value.${output}'; console.log(value);`,
    [`src/value.${source}`]: "export const value = 1;",
  });
  expect(findings).toEqual([]);
});

test.each(["export { value } from './value.js'", "void import('./value.js')"])(
  "resolves output extensions in %s",
  async (statement) => {
    expect(
      await diagnose({ "src/main.ts": statement, "src/value.ts": "export const value = 1;" }),
    ).toEqual([]);
  },
);

test("exact JavaScript files take precedence over TypeScript substitutions", async () => {
  const findings = await diagnose({
    "src/main.ts": "import { value } from './value.js'; console.log(value);",
    "src/value.js": "export const value = 1;",
    "src/value.ts": "export const shadowed = 2;",
  });
  expect(findings.filter((item) => item.rule === "workspace/dead-code/unresolved-import")).toEqual(
    [],
  );
  expect(
    findings
      .filter((item) => item.rule === "workspace/dead-code/unused-file")
      .map((item) => item.file),
  ).toEqual(["src/value.ts"]);
});

test("TypeScript extension substitution retains real static cycles", async () => {
  const findings = await diagnose(
    {
      "src/main.ts": "import './other.js';",
      "src/other.ts": "import './main.js';",
    },
    "graph",
  );
  expect(
    findings.filter((item) => item.rule === "workspace/dead-code/circular-dependency"),
  ).toHaveLength(1);
});

test("a missing output import still reports an unresolved dependency", async () => {
  const findings = await diagnose({ "src/main.ts": "import './missing.js';" });
  expect(findings.filter((item) => item.rule === "workspace/dead-code/unresolved-import")).toEqual([
    {
      rule: "workspace/dead-code/unresolved-import",
      file: "src/main.ts",
      message: 'Import "./missing.js" could not be resolved.',
    },
  ]);
});
