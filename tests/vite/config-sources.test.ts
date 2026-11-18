import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { main } from "../../src/cli.ts";

const roots: string[] = [];
const secretDefine = "vite/define/no-secret-define";
const viteConfigWithSecret = (doctorKey = "") =>
  `import { defineConfig } from "vite-plus";\n\nexport default defineConfig({\n  define: { SECRET_KEY: JSON.stringify("secret") },${doctorKey}\n});\n`;

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "doctor-config-sources-"));
  roots.push(root);
  const all = { "package.json": JSON.stringify({ dependencies: { vite: "^7.0.0" } }), ...files };
  for (const [file, contents] of Object.entries(all)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), contents);
  }
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function run(root: string, args: string[] = []) {
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  const code = await main([root, "--no-cache", "--format", "json", ...args]);
  vi.restoreAllMocks();
  return { code, report: JSON.parse(output) };
}

const codes = (report: { diagnostics?: Array<{ code: string }> }) =>
  (report.diagnostics ?? []).map((diagnostic) => diagnostic.code);

test.each([
  ["an empty object", "{}"],
  ["empty rules", '{ "rules": {} }'],
  [
    "empty selections and auto extends",
    '{ "$schema": "x", "extends": "auto", "rules": {}, "suppressions": [], "exclude": [], "overrides": [] }',
  ],
  ["extends listing only auto", '{ "extends": ["auto"] }'],
])("doctor.config.json with %s reports DOC0038", async (_, config) => {
  const root = fixture({ "doctor.config.json": config });
  const { code, report } = await run(root);
  expect(code).toBe(0);
  expect(report.diagnostics).toMatchObject([
    {
      code: "DOC0038",
      rule: "doctor/config/default-config-file",
      severity: "info",
      location: { path: "doctor.config.json" },
    },
  ]);
});

test.each([
  ["a rule setting", `{ "rules": { "${secretDefine}": "off" } }`],
  ["include globs", '{ "include": ["src/**/*.ts"] }'],
  ["an empty include list", '{ "include": [] }'],
  ["an empty extends list", '{ "extends": [] }'],
  ["a preset", '{ "extends": ["vite-doctor/vite/strict"] }'],
  ["a cache directory", '{ "cache": { "dir": ".cache/doctor" } }'],
  [
    "a per-path override",
    `{ "overrides": [{ "files": ["vite.config.ts"], "rules": { "${secretDefine}": "off" } }] }`,
  ],
])("doctor.config.json with %s does not report DOC0038", async (_, config) => {
  const root = fixture({ "doctor.config.json": config });
  const { report } = await run(root);
  expect(codes(report)).not.toContain("DOC0038");
});

test("DOC0038 is not reported for Rule selections or changed-file runs", async () => {
  const root = fixture({ "doctor.config.json": "{}" });
  expect(codes((await run(root, ["--rules", secretDefine])).report)).not.toContain("DOC0038");
  expect(codes((await run(root, ["--analyses", "graph"])).report)).not.toContain("DOC0038");
});

test("the CLI reads the doctor key of vite.config.ts without running it", async () => {
  const root = fixture({
    "vite.config.ts": `import { writeFileSync } from "node:fs";
import { defineConfig } from "vite-plus";
import { defineDoctorConfig } from "vite-doctor";

writeFileSync(new URL("./vite-config-ran", import.meta.url), "yes");

export default defineConfig({
  define: { SECRET_KEY: JSON.stringify("secret") },
  doctor: defineDoctorConfig({
    rules: { "${secretDefine}": "off" },
  }),
});
`,
  });
  const before = await run(root, ["--rules", secretDefine]);
  expect(before.code).toBe(0);
  expect(before.report.diagnostics).toEqual([]);
  expect(existsSync(join(root, "vite-config-ran"))).toBe(false);
});

test.each([
  ["export default {", "}"],
  ["const config = {", "}\nexport default config"],
  ["export default defineConfig(() => ({", "}))"],
  ["export default defineConfig(async () => { return {", "} })"],
  ["export default {", "} satisfies UserConfig"],
])("the CLI finds the doctor key in %s", async (open, close) => {
  const root = fixture({
    "vite.config.ts": `${open}\n  define: { SECRET_KEY: JSON.stringify("secret") },\n  "doctor": { rules: { "${secretDefine}": "off" } },\n${close}\n`,
  });
  expect((await run(root, ["--rules", secretDefine])).report.diagnostics).toEqual([]);
});

test("Vite rules read a vite-plus defineConfig() without a doctor key", async () => {
  const root = fixture({ "vite.config.ts": viteConfigWithSecret() });
  const { code, report } = await run(root, ["--rules", secretDefine]);
  expect(code).toBe(1);
  expect(report.diagnostics).toMatchObject([{ rule: secretDefine }]);
});

test("a doctor key that needs code to evaluate is a config error that names the file", async () => {
  const root = fixture({
    "vite.config.ts": viteConfigWithSecret(
      `\n  doctor: { rules: { [process.env.RULE!]: "off" } },`,
    ),
  });
  const { code, report } = await run(root);
  expect(code).toBe(2);
  expect(report).toMatchObject({
    status: "failed",
    error: { kind: "config", file: join(root, "vite.config.ts") },
    next: { action: "fix-config", file: join(root, "vite.config.ts") },
  });
  expect(report.error.message).toContain("line 5");
  expect(report.error.message).toContain("without running it");
});

test("an invalid rule severity in the doctor key points to vite.config.ts", async () => {
  const root = fixture({
    "vite.config.ts": viteConfigWithSecret(
      `\n  doctor: { rules: { "${secretDefine}": "fatal" } },`,
    ),
  });
  const { code, report } = await run(root);
  expect(code).toBe(2);
  expect(report.error).toMatchObject({ kind: "config", file: join(root, "vite.config.ts") });
});

test("doctor.config.json and a vite.config.ts doctor key together are a config error", async () => {
  const root = fixture({
    "doctor.config.json": `{ "rules": { "${secretDefine}": "off" } }`,
    "vite.config.ts": viteConfigWithSecret(`\n  doctor: { rules: {} },`),
  });
  const { code, report } = await run(root);
  expect(code).toBe(2);
  expect(report.error).toMatchObject({ kind: "config", file: join(root, "doctor.config.json") });
  expect(report.error.message).toContain("Keep one of them");
});

test("--config replaces the vite.config.ts doctor key", async () => {
  const root = fixture({
    "doctor.config.ts": "export default { rules: {} }\n",
    "vite.config.ts": viteConfigWithSecret(`\n  doctor: { rules: { "${secretDefine}": "off" } },`),
  });
  const { code } = await run(root, ["--rules", secretDefine, "--config", "doctor.config.ts"]);
  expect(code).toBe(1);
});
