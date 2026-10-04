import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../src/core/testkit.ts";
import { doctor } from "../../src/plugin.ts";
import { noBrowserGlobalInSsrEntry } from "../../src/rules.ts";

async function diagnose(source: string) {
  return runRuleFixture({
    rule: noBrowserGlobalInSsrEntry,
    framework: "vite",
    files: { "src/entry-server.ts": source },
  });
}

test.each([
  "export const render = data => data.document",
  "export const render = window => window.document",
  "export function render({ document }) { return document.title }",
  "export function render(window: { title: string }) { return window.title }",
  "import document from './dom'; export const render = () => document.title",
  "export function document() { return 'html' }; export const render = () => document()",
  "export interface View { window: string; document: string }",
  "export type Browser = typeof window",
  "const value = { document: 'html' }; export { value }",
  "export const render = () => typeof document",
  "export const render = () => typeof globalThis.document",
  "export const render = (globalThis) => globalThis.document",
  "if (!import.meta.env.SSR) document.title = 'client'",
  "if (import.meta.env.SSR) {} else document.title = 'client'",
  "export const value = import.meta.env.SSR ? 'server' : document.title",
  "export const value = !import.meta.env.SSR ? document.title : 'server'",
  "!import.meta.env.SSR && document.title",
  "import.meta.env.SSR || document.title",
  "if (import.meta.env.SSR === false) document.title = 'client'",
  "if (import.meta.env['SSR'] !== true) document.title = 'client'",
  "if (!import.meta.env.SSR && ready) document.title = 'client'",
])("ignores non-global references or client branches: %s", async (source) => {
  expect((await diagnose(source)).diagnostics).toEqual([]);
});

test.each([
  "export const render = () => document.title",
  "export const render = () => typeof window.document",
  "export const render = () => typeof globalThis.window.document",
  "function helper(document) { return document.title }; export const render = () => document.title",
  "{ const window = {} }; export const render = () => window.location",
  "export const render = () => ({ document })",
  "export const render = () => data[document]",
  "export const render = () => globalThis.document.title",
  "export const render = () => globalThis['document'].title",
  "if (import.meta.env.SSR) document.title = 'server'",
  "if (!import.meta.env.SSR) {} else document.title = 'server'",
  "export const value = import.meta.env.SSR ? document.title : 'client'",
  "import.meta.env.SSR && document.title",
  "!import.meta.env.SSR || document.title",
  "if (!import.meta.env.SSR || ready) document.title = 'maybe server'",
  "const SSR = 'DEV'; if (!import.meta.env[SSR]) document.title = 'maybe server'",
])("reports a browser reference that can execute on the server: %s", async (source) => {
  expect((await diagnose(source)).diagnostics.map(({ code }) => code)).toEqual(["VITE0018"]);
});

test("allows the documented SSR flag in an actual Vite server bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-ssr-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    const entry = join(root, "src/entry-server.ts");
    await writeFile(
      entry,
      `export function render() {
      if (!import.meta.env.SSR) return document.title
      return 'server rendered'
    }`,
    );
    const result = await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [doctor({ rules: noBrowserGlobalInSsrEntry.meta.id, mode: "error", cache: false })],
      build: { ssr: entry, write: false },
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) =>
      "output" in item ? item.output : [],
    );
    const entryChunk = outputs.find((item) => item.type === "chunk" && item.isEntry);
    expect(entryChunk?.type).toBe("chunk");
    if (entryChunk?.type !== "chunk") throw new Error("Missing SSR entry chunk");
    expect(entryChunk.code).not.toContain("document.title");
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(entryChunk.code).toString("base64")}`
    );
    expect(module.render()).toBe("server rendered");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
