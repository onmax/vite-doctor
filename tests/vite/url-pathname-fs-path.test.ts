import { describe, expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../src/core/testkit.ts";
import { noUrlPathnameAsFsPath, viteRulePack } from "../../src/rules.ts";
import { diagnosticsCollectionSource, getDiagnosticDocuments } from "../../docs/rules/source.ts";

function run(file: string, source: string) {
  return runProjectFixture({
    framework: "vite",
    rules: [noUrlPathnameAsFsPath],
    files: { [file]: source },
  });
}

describe("vite/config/no-url-pathname-as-fs-path", () => {
  test("reports alias targets in a Vitest config (vitehub packages/workspace/vitest.config.ts)", async () => {
    const result = await run(
      "packages/workspace/vitest.config.ts",
      `import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "#vitehub-workspace-assets-registry": new URL("src/runtime/empty-assets-registry.ts", import.meta.url).pathname,
      "#vitehub-workspace-registry": new URL("src/runtime/empty-registry.ts", import.meta.url).pathname,
      "@vite-hub/shell/workspace": new URL("../shell/src/workspace/index.ts", import.meta.url).pathname,
    },
  },
})`,
    );
    expect(result.diagnostics.map((diagnostic) => diagnostic.range?.line)).toEqual([6, 7, 8]);
    expect(result.diagnostics[0]).toMatchObject({
      code: "VITE0027",
      ruleId: "vite/config/no-url-pathname-as-fs-path",
      severity: "warn",
      range: { line: 6, column: 45 },
    });
  });

  test("reports a vite-plus config without a Vite import (vitehub ab58b82c0^ packages/blob/vite.config.ts)", async () => {
    const result = await run(
      "vite.config.ts",
      `export default {
  pack: {
    alias: {
      undici: new URL("./src/internal/vercel-fetch.ts", import.meta.url).pathname,
    },
  },
}`,
    );
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("VITE0027");
  });

  test("reports a const URL read in a module that imports from vite", async () => {
    const result = await run(
      "src/plugins/registry.ts",
      `import type { Plugin } from "vite"
import { readFileSync } from "node:fs"

const runtimeDir = new URL("../runtime/", import.meta.url)

export function registry(): Plugin {
  return {
    name: "registry",
    load() {
      return readFileSync(runtimeDir.pathname + "registry.ts", "utf8")
    },
  }
}`,
    );
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.range?.line).toBe(10);
  });

  test.each([
    [
      "fileURLToPath",
      "vitest.config.ts",
      `import { fileURLToPath } from "node:url"
export default { resolve: { alias: { "#a": fileURLToPath(new URL("./src/a.ts", import.meta.url)) } } }`,
    ],
    [
      "request URLs used for routing in a plugin",
      "src/plugin.ts",
      `import type { Plugin } from "vite"
export default (): Plugin => ({
  name: "router",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (new URL(req.url || "/", "http://localhost").pathname !== "/__api") return next()
      res.end()
    })
  },
})`,
    ],
    [
      "client code that does not import from vite",
      "src/main.ts",
      `const logo = new URL("./logo.svg", import.meta.url).pathname
document.querySelector("img")!.src = logo`,
    ],
    [
      "href reads",
      "vite.config.ts",
      `export default { define: { __URL__: JSON.stringify(new URL("./a", import.meta.url).href) } }`,
    ],
    [
      "a parameter that shadows a URL const",
      "vite.config.ts",
      `const url = new URL("./a", import.meta.url)
export const route = (url) => url.pathname
export default {}`,
    ],
    [
      "a reassigned let binding",
      "vite.config.ts",
      `let target = new URL("./a", import.meta.url)
target = new URL("https://example.com/a")
export default { base: target.pathname }`,
    ],
    [
      "a destructured parameter that shadows a URL const",
      "vite.config.ts",
      `const base = new URL("./runtime", import.meta.url)
export const route = ({ base }) => base.pathname
export default {}`,
    ],
    [
      "a local URL class",
      "vite.config.ts",
      `class URL {
  constructor(public pathname: string, base: string) {}
}
export default { base: new URL("/app/", import.meta.url).pathname }`,
    ],
  ])("accepts %s", async (_label, file, source) => {
    const result = await run(file, source);
    expect(result.diagnostics).toEqual([]);
  });

  test("reports a URL const after an unrelated function shadowed its name", async () => {
    const result = await run(
      "vite.config.ts",
      `function use(base) {
  return base
}
const base = new URL("./runtime", import.meta.url)
export default { resolve: { alias: { "#runtime": base.pathname } } }`,
    );
    expect(result.diagnostics).toHaveLength(1);
  });

  test("is Recommended and documents VITE0027", async () => {
    expect(viteRulePack.presets?.recommended).toContain(noUrlPathnameAsFsPath.meta.id);
    expect(getDiagnosticDocuments()).toContainEqual(
      expect.objectContaining({
        code: "VITE0027",
        ruleId: noUrlPathnameAsFsPath.meta.id,
        path: "/diagnostics/VITE0027",
      }),
    );
    const page = await diagnosticsCollectionSource.getItem("diagnostics/VITE0027.md");
    expect(page).toContain("fileURLToPath");
  });
});
