import { expect, test } from "vite-plus/test";
import { mergeConfig, resolveConfig } from "vite";
import { runProjectFixture } from "../../src/core/testkit.ts";
import { noBroadFsAllow, noDisabledFsStrict } from "../../src/rules.ts";

async function diagnose(source: string) {
  return runProjectFixture({
    framework: "vite",
    rules: [noBroadFsAllow, noDisabledFsStrict],
    files: { "vite.config.ts": source },
  });
}

test.each([
  "export default { server: { fs: {} }, customPlugin: { strict: false } }",
  "export default { customPlugin: { allow: ['/'] }, server: { fs: { allow: ['./src'] } } }",
  "export default { customPlugin: { fs: { strict: false, allow: ['/'] } } }",
  "const unused = { server: { fs: { strict: false, allow: ['/'] } } }; export default {}",
  "export default { customPlugin: { server: { fs: { strict: false, allow: ['/'] } } } }",
  "// server: { fs: { strict: false, allow: ['/'] } }\nexport default {}",
  "const example = `server: { fs: { strict: false, allow: ['/'] } }`; export default {}",
  "export default { server: { fs: { strict: true, allow: ['./src'] } } }",
  "export default { server: { fs: { strict: false, strict: true, allow: ['/'], allow: ['./src'] } } }",
  "export default { server: { fs: { strict: false, allow: ['/'] }, fs: {} } }",
  "export default { server: { fs: { strict: false, allow: ['/'] } }, server: {} }",
  "export default { server: { fs: { strict: false, allow: ['/'], ...unknown } } }",
  "export default { server: { fs: { strict: false, allow: ['/'], ...{ strict: true, allow: ['./src'] } } } }",
  "export default { server: { fs: { strict: false, allow: ['/'], [key]: safe } } }",
  "import { defineConfig } from 'other'; export default defineConfig({ server: { fs: { strict: false, allow: ['/'] } } })",
  "const config = { server: { fs: { strict: false, allow: ['/'] } } }; export default (config) => config",
  "export default () => { function helper() { return { server: { fs: { strict: false, allow: ['/'] } } } }; return {} }",
])("ignores configuration outside effective server.fs properties: %s", async (source) => {
  expect((await diagnose(source)).diagnostics).toEqual([]);
});

test.each([
  "export default { server: { fs: { strict: false, allow: ['/'] } } }",
  "export default { 'server': { 'fs': { 'strict': false, 'allow': ['/'] } } }",
  "export default { ['server']: { ['fs']: { ['strict']: false, ['allow']: ['/'] } } }",
  "import { defineConfig } from 'vite'; export default defineConfig({ server: { fs: { strict: false, allow: ['/'] } } })",
  "import { defineConfig as config } from 'vite'; export default config({ server: { fs: { strict: false, allow: ['/'] } } })",
  "export default () => ({ server: { fs: { strict: false, allow: ['/'] } } })",
  "export default () => { return { server: { fs: { strict: false, allow: ['/'] } } } }",
  "const config = { server: { fs: { strict: false, allow: ['/'] } } }; export default config",
  "const config = { server: { fs: { strict: false, allow: ['/'] } } }; export { config as default }",
  "module.exports = { server: { fs: { strict: false, allow: ['/'] } } }",
  "export default { unrelated: { allow: ['./src'] }, server: { fs: { strict: false, allow: ['/'] } } }",
  "export default { server: { fs: { strict: false, allow: ['/'] } }, 1: 'metadata' }",
  "import * as Vite from 'vite'; export default Vite.defineConfig({ server: { fs: { strict: false, allow: ['/'] } } })",
  "const fs = { strict: false, allow: ['/'] }; export default { server: { fs } }",
  "export default { server: { fs: { ...unknown, strict: false, allow: ['/'] } } }",
  "export default { server: { fs: { ...{ strict: false, allow: ['/'] } } } }",
  "const fs = { strict: false, allow: ['/'] }; export default flag ? { server: { fs } } : { server: { fs } }",
])("reports unsafe entries owned by the exported Vite configuration: %s", async (source) => {
  const result = await diagnose(source);
  expect(result.diagnostics.map(({ code }) => code).sort()).toEqual(["VITE0016", "VITE0017"]);
});

test("matches Vite's effective filesystem options after an override", async () => {
  const unsafe = { strict: false, allow: ["/"] };
  const server = { fs: { ...unsafe, strict: true, allow: ["./src"] } };
  const config = await resolveConfig({ configFile: false, logLevel: "silent", server }, "serve");
  expect(config.server.fs.strict).toBe(true);
  const source = `const unsafe = { strict: false, allow: ['/'] }; export default { server: { fs: { ...unsafe, strict: true, allow: ['./src'] } } }`;
  expect((await diagnose(source)).diagnostics).toEqual([]);
});

test("reports each broad allow entry at its own source range", async () => {
  const source = `export default { server: { fs: { allow: ['./src', '/', '/home/alice', '../', '/Users/bob'] } } }`;
  const result = await diagnose(source);
  expect(result.diagnostics).toHaveLength(4);
  expect(result.diagnostics.map(({ range }) => source.slice(range!.start, range!.end))).toEqual([
    "'/'",
    "'/home/alice'",
    "'../'",
    "'/Users/bob'",
  ]);
});

test.each([
  "import { defineConfig, mergeConfig } from 'vite'; export default defineConfig(mergeConfig({}, { server: { fs: { strict: false, allow: ['/'] } } }))",
  "import { mergeConfig as merge } from 'vite'; const base = { server: { fs: { strict: false } } }; export default merge(base, { server: { fs: { allow: ['/'] } } })",
  "import * as Vite from 'vite'; export default Vite.mergeConfig({ server: { fs: { strict: false, allow: ['/'] } } }, { server: { fs: {} } })",
  "import { mergeConfig } from 'vite'; export default mergeConfig(mergeConfig({}, { server: { fs: { strict: false } } }), { server: { fs: { allow: ['/'] } } })",
  "const allow = ['/']; export default { server: { fs: { strict: false, allow: [...allow] } } }",
  "const broad = ['/']; const allow = [...broad]; export default { server: { fs: { strict: false, allow: ['./src', ...allow] } } }",
])("reports statically composed filesystem options: %s", async (source) => {
  expect((await diagnose(source)).diagnostics.map(({ code }) => code).sort()).toEqual([
    "VITE0016",
    "VITE0017",
  ]);
});

test.each([
  "import { mergeConfig } from 'other'; export default mergeConfig({}, { server: { fs: { strict: false, allow: ['/'] } } })",
  "import { mergeConfig } from 'vite'; export default (mergeConfig) => mergeConfig({}, { server: { fs: { strict: false, allow: ['/'] } } })",
  "import { mergeConfig } from 'vite'; export default mergeConfig(unknown, { server: { fs: { strict: false, allow: ['/'] } } })",
  "import { mergeConfig } from 'vite'; export default mergeConfig({ server: { fs: { strict: false, allow: ['/'] } } }, loadConfig())",
  "import { mergeConfig } from 'vite'; export default mergeConfig({ server: { fs: { strict: false } } }, { server: { fs: { strict: true } } })",
  "export default { server: { fs: { allow: [...unknown] } } }",
  "const allow = [...allow]; export default { server: { fs: { allow: [...allow] } } }",
])("keeps unknown compositions and effective safe overrides conservative: %s", async (source) => {
  expect((await diagnose(source)).diagnostics).toEqual([]);
});

test("preserves known allow entries across unknown merge properties", async () => {
  const source =
    "import { mergeConfig } from 'vite'; export default mergeConfig({ server: { fs: { allow: ['/'] } } }, { server: { fs: { ...unknown } } })";
  const result = await diagnose(source);
  expect(result.diagnostics.map(({ code }) => code)).toEqual(["VITE0016"]);
  expect(source.slice(result.diagnostics[0]!.range!.start, result.diagnostics[0]!.range!.end)).toBe(
    "'/'",
  );
});

test("matches Vite deep merge overrides and allow-list concatenation", async () => {
  const base = { server: { fs: { strict: false, allow: ["/"] } } };
  const override = { server: { fs: { strict: true, allow: ["./src"] } } };
  const merged = mergeConfig(base, override);
  expect(merged.server.fs).toEqual({ strict: true, allow: ["/", "./src"] });
  const source = `import { mergeConfig } from 'vite'; export default mergeConfig({ server: { fs: { strict: false, allow: ['/'] } } }, { server: { fs: { strict: true, allow: ['./src'] } } })`;
  const result = await diagnose(source);
  expect(result.diagnostics.map(({ code }) => code)).toEqual(["VITE0016"]);
  expect(source.slice(result.diagnostics[0]!.range!.start, result.diagnostics[0]!.range!.end)).toBe(
    "'/'",
  );
});

test("reports spread entries at their original ranges while ignoring unknown contents", async () => {
  const source = `const broad = ['/', '/home/alice']; const allow = [...broad]; export default { server: { fs: { allow: [...unknown, ...allow, '../', ...unknown] } } }`;
  const result = await diagnose(source);
  expect(result.diagnostics.map(({ code }) => code)).toEqual(["VITE0016", "VITE0016", "VITE0016"]);
  expect(result.diagnostics.map(({ range }) => source.slice(range!.start, range!.end))).toEqual([
    "'/'",
    "'/home/alice'",
    "'../'",
  ]);
});
