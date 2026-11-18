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
  ['import { defineConfig } from "vite"; export default defineConfig(() => ({', "}))"],
  [
    'import { defineConfig } from "vite-plus"; export default defineConfig(async () => { return {',
    "} })",
  ],
  ["export default {", "} satisfies UserConfig"],
])("the CLI finds the doctor key in %s", async (open, close) => {
  const root = fixture({
    "vite.config.ts": `${open}\n  define: { SECRET_KEY: JSON.stringify("secret") },\n  "doctor": { rules: { "${secretDefine}": "off" } },\n${close}\n`,
  });
  expect((await run(root, ["--rules", secretDefine])).report.diagnostics).toEqual([]);
});

test.each([
  ["vite.config.ts", 'export default function () { return { ["doctor"]: { include: [] } }; }'],
  [
    "vite.config.ts",
    'const config = { "\\u0064octor": { include: [] } }; export { config as default };',
  ],
  ["vite.config.cjs", "module.exports = { doctor: { include: [] } };"],
  ["vite.config.cjs", "const config = { doctor: { include: [] } }; module.exports = config;"],
  ["vite.config.ts", "export default { ...other, doctor: computed(), doctor: { include: [] } };"],
  [
    "vite.config.ts",
    "const config = { plugins: [{ config() { return {}; } }], doctor: { include: [] } }; export default config;",
  ],
  [
    "vite.config.ts",
    "const config = { doctor: { include: [] }, plugins: [{ config(config) { return config; } }] }; export { config as default };",
  ],
  [
    "vite.config.ts",
    "import { defineDoctorConfig as helper } from 'vite-doctor'; export default ({ helper: ignored }) => ({ doctor: helper({ include: [] }) });",
  ],
])("%s recognizes literal settings in %s", async (file, source) => {
  const root = fixture({ [file]: source });
  expect((await run(root)).code).toBe(0);
  writeFileSync(join(root, "doctor.config.json"), "{}");
  expect((await run(root)).report.error?.message).toContain("Keep one of them");
});

test.each([
  "export default () => { const alias = { doctor: '/src/doctor.ts' }; return { resolve: { alias } }; };",
  "export default () => { const alias = {}; alias.doctor = '/src/doctor.ts'; return { resolve: { alias } }; };",
  "export default { resolve: { alias: { doctor: '/src/doctor.ts' } } };",
])("allows JSON when the static Vite export has no doctor key: %s", async (source) => {
  const root = fixture({ "vite.config.ts": source, "doctor.config.json": "{}" });
  const { code, report } = await run(root);
  expect(code).toBe(0);
  expect(codes(report)).toContain("DOC0038");
});

test.each([
  "const base = { doctor: { include: ['app.ts'] } }; export default { doctor: { include: [] }, ...base };",
  "const key = 'doctor'; export default { doctor: { include: [] }, [key]: { include: ['app.ts'] } };",
  "import { mergeConfig } from 'vite'; export default mergeConfig({ doctor: { include: [] } }, {});",
  "export default () => { if (process.env.CI) return {}; return { doctor: { include: [] } }; };",
  "export default (config = { doctor: { include: [] } }) => config;",
  "const defineDoctorConfig = () => ({ include: ['app.ts'] }); export default { doctor: defineDoctorConfig({ include: [] }) };",
  "import { defineDoctorConfig as helper } from 'vite-doctor'; export default (helper) => ({ doctor: helper({ include: [] }) });",
  "import { defineDoctorConfig as helper } from 'vite-doctor'; export default ({ nested: { helper } }) => ({ doctor: helper({ include: [] }) });",
  "const config = { doctor: { include: [] } }; config.doctor = { include: ['app.ts'] }; export default config;",
  "const config = { doctor: { include: [] } }; useConfig(config); export default config;",
  "export default () => { const config = {}; config.doctor = { include: [] }; return config; };",
  "export default { ...(process.env.CI ? { doctor: { include: [] } } : {}) };",
])("does not guess the effective setting in %s", async (source) => {
  const root = fixture({ "vite.config.ts": source });
  const { code, report } = await run(root);
  expect(code).toBe(2);
  expect(report.error).toMatchObject({ kind: "config", file: join(root, "vite.config.ts") });
  expect(report.error.message).toContain("line 1");
});

test.each([
  "import { mergeConfig } from 'vite-plus'; const makeBase = () => ({ doctor: { extends: [] } }); export default mergeConfig(makeBase(), { base: '/' });",
  "export default { resolve: { alias: { doctor: '/src/doctor.ts' } }, ...base };",
  "const config = { doctor: { include: [] } }; export default (config) => config;",
  "const { config } = { config: {}, doctor: '/src/doctor.ts' }; export default config;",
  "const config = {}; function unused() { config.doctor = {} } export default config;",
  "export { default } from './base';",
  "export default {",
])("requires explicit config when the export is indeterminate: %s", async (source) => {
  const root = fixture({ "vite.config.ts": source });
  for (const withJson of [false, true]) {
    if (withJson) writeFileSync(join(root, "doctor.config.json"), "{}");
    const { code, report } = await run(root);
    expect(code).toBe(2);
    expect(report.error).toMatchObject({ kind: "config", file: join(root, "vite.config.ts") });
    expect(report.error.message).toContain(
      "Cannot determine whether vite.config provides a doctor key",
    );
    expect(report.error.message).toContain("--config <file>");
    expect(codes(report)).not.toContain("DOC0038");
  }
  const explicit = await run(root, ["--config", "doctor.config.json"]);
  expect(explicit.report.error?.kind).not.toBe("config");
  expect(explicit.code).toBe(source === "export default {" ? 3 : 0);
  expect(codes(explicit.report)).not.toContain("DOC0038");
});

test("DOC0038 does not suggest deleting an explicitly selected config", async () => {
  const root = fixture({ "doctor.config.json": "{}" });
  expect(codes((await run(root, ["--config", "doctor.config.json"])).report)).not.toContain(
    "DOC0038",
  );
});

test("DOC0038 does not suggest restoring an inherited exclusion", async () => {
  const root = fixture({
    "package.json": JSON.stringify({ dependencies: { nuxt: "^4.0.0" } }),
    ".nuxt/doctor.manifest.json": JSON.stringify({ doctorConfig: { exclude: ["**/*.ts"] } }),
    "doctor.config.json": '{ "exclude": [] }',
    "app/app.ts": "export const value = 1;",
  });
  expect(codes((await run(root)).report)).not.toContain("DOC0038");
  writeFileSync(join(root, "doctor.config.json"), "{}");
  expect(codes((await run(root)).report)).toContain("DOC0038");
});

test("the emitted default-config Diagnostic can be explained by code and Rule ID", async () => {
  const root = fixture({ "doctor.config.json": "{}" });
  const { report } = await run(root);
  const diagnostic = report.diagnostics.find((item: { code: string }) => item.code === "DOC0038");
  expect(diagnostic).toBeDefined();
  for (const selector of [diagnostic.code, diagnostic.rule]) {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await main(["explain", selector, "--format", "agent"], root)).toBe(0);
    expect(JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join(""))).toMatchObject({
      status: "ready",
      diagnosticCodes: ["DOC0038"],
    });
    stdout.mockRestore();
  }
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
