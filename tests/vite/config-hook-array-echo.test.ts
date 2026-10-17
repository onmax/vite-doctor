import { describe, expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../src/core/testkit.ts";
import { noConfigHookArrayEcho, viteRulePack } from "../../src/rules.ts";
import { diagnosticsCollectionSource, getDiagnosticDocuments } from "../../docs/rules/source.ts";

function run(source: string) {
  return runProjectFixture({
    framework: "vite",
    rules: [noConfigHookArrayEcho],
    files: { "src/vite.ts": source },
  });
}

const prelude = `import type { Plugin } from "vite"
import { createNoExternalMerger, isServerEnvironment } from "@vite-hub/internal/build/vite"
const WORKSPACE_PACKAGE_NAME = "@vite-hub/workspace"
const mergeNoExternal = createNoExternalMerger(WORKSPACE_PACKAGE_NAME)
`;

describe("vite/plugin/no-config-hook-array-echo", () => {
  test("reports a same-file helper that returns the incoming array (vitehub 9ad7b6825^ workspace plugin)", async () => {
    const result = await run(`${prelude}
function mergeDedupe(current: string[] | undefined): string[] {
  if (!current) return [WORKSPACE_PACKAGE_NAME]
  return current.includes(WORKSPACE_PACKAGE_NAME) ? current : [...current, WORKSPACE_PACKAGE_NAME]
}

export function hubWorkspace(): Plugin {
  return {
    name: "@vite-hub/workspace/vite",
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) return
      return {
        resolve: {
          dedupe: mergeDedupe(config.resolve?.dedupe),
          noExternal: mergeNoExternal(config.resolve?.noExternal),
        },
      }
    },
  }
}`);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: "VITE0026",
      ruleId: "vite/plugin/no-config-hook-array-echo",
      severity: "warn",
      range: { line: 18 },
    });
    expect(result.diagnostics[0]?.message).toContain("resolve.dedupe");
  });

  test.each([
    [
      "a direct spread",
      `config(config) {
      return { ssr: { noExternal: [...config.ssr.noExternal, "my-lib"] } }
    }`,
      "ssr.noExternal",
    ],
    [
      "a spread with an empty fallback",
      `config(config) {
      return { resolve: { dedupe: [...(config.resolve?.dedupe ?? []), "vue"] } }
    }`,
      "resolve.dedupe",
    ],
    [
      "a Set-deduplicated spread",
      `async config(config, environment) {
      return { resolve: { dedupe: [...new Set([...(config.resolve?.dedupe || []), "yjs"])] } }
    }`,
      "resolve.dedupe",
    ],
    [
      "concat on the incoming array",
      `config: (config) => ({ optimizeDeps: { include: config.optimizeDeps.include.concat(["a"]) } })`,
      "optimizeDeps.include",
    ],
    [
      "a local alias in a handler-object hook",
      `config: {
      order: "pre",
      handler(config) {
        const ignored = config.server?.watch?.ignored ?? []
        return { server: { watch: { ignored: [...ignored, "**/.cache/**"] } } }
      },
    }`,
      "server.watch.ignored",
    ],
    [
      "a returned variable extended by assignment",
      `config(config) {
      const result = { define: { A: "1" } }
      if (config.ssr) result.ssr = { noExternal: [...config.ssr.noExternal, "x"] }
      return result
    }`,
      "ssr.noExternal",
    ],
    [
      "an alias with a non-empty fallback",
      `config(config) {
      const entries = config.resolve?.dedupe ?? ["vue"]
      return { resolve: { dedupe: [...entries, "x"] } }
    }`,
      "resolve.dedupe",
    ],
    [
      "an object alias returned through a spread",
      `config(config) {
      const result = { resolve: { dedupe: [...config.resolve.dedupe, "x"] } }
      return { ...result }
    }`,
      "resolve.dedupe",
    ],
    [
      "concat with the incoming array as an argument",
      `config(config) {
      return { resolve: { dedupe: ["vue"].concat(config.resolve.dedupe) } }
    }`,
      "resolve.dedupe",
    ],
  ])("reports %s", async (_label, hook, path) => {
    const result = await run(`import type { Plugin } from "vite"
export default function plugin(): Plugin {
  return {
    name: "fixture",
    ${hook},
  }
}`);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("VITE0026");
    expect(result.diagnostics[0]?.message).toContain(path);
  });

  test.each([
    [
      "only additions from a helper (vitehub 9ad7b6825 fix)",
      `import type { Plugin } from "vite"
function dedupeAddition(current: string[] | undefined): string[] | undefined {
  return current?.includes("vue") ? undefined : ["vue"]
}
export default (): Plugin => ({
  name: "fixture",
  configEnvironment(name, config) {
    return { resolve: { dedupe: dedupeAddition(config.resolve?.dedupe) } }
  },
})`,
    ],
    [
      "in-place mutation of the incoming config",
      `import type { Plugin } from "vite"
export default (): Plugin => ({
  name: "fixture",
  async config(config) {
    config.resolve = {
      ...config.resolve,
      dedupe: [...new Set([...(config.resolve?.dedupe || []), "yjs"])],
    }
  },
})`,
    ],
    [
      "helpers imported from another file",
      `${prelude}
export default () => ({
  name: "fixture",
  config(config) {
    return { ssr: { noExternal: mergeNoExternal(config.ssr?.noExternal) } }
  },
})`,
    ],
    [
      "copying an array to a different config path",
      `import type { Plugin } from "vite"
export default (): Plugin => ({
  name: "fixture",
  config(config) {
    return { optimizeDeps: { include: [...(config.ssr?.noExternal ?? [])] } }
  },
})`,
    ],
    [
      "spreading object-valued config",
      `import type { Plugin } from "vite"
export default (): Plugin => ({
  name: "fixture",
  config(config) {
    return { define: { __APP__: "1", ...config.define } }
  },
})`,
    ],
    [
      "config methods on objects that are not plugins",
      `export const store = {
  config(config) {
    return { items: [...config.items, "x"] }
  },
}`,
    ],
    [
      "spreads inside nested callbacks",
      `import type { Plugin } from "vite"
export default (): Plugin => ({
  name: "fixture",
  config(config) {
    const later = () => ({ resolve: { dedupe: [...config.resolve.dedupe] } })
    return { resolve: { conditions: ["worker"] } }
  },
})`,
    ],
    [
      "named objects with a config method outside Vite code",
      `export const store = {
  name: "store",
  config(config) {
    return { items: [...config.items, "x"] }
  },
}`,
    ],
    [
      "a shadowed alias",
      `import type { Plugin } from "vite"
export default (): Plugin => ({
  name: "fixture",
  config(config) {
    const current = config.resolve?.dedupe
    {
      const current = ["known"]
      return { resolve: { dedupe: [...current, "new"] } }
    }
  },
})`,
    ],
    [
      "returning the mutated incoming config",
      `import type { Plugin } from "vite"
export default (): Plugin => ({
  name: "fixture",
  config(config) {
    config.resolve.dedupe = [...config.resolve.dedupe, "x"]
    return config
  },
})`,
    ],
    [
      "a reassigned alias",
      `import type { Plugin } from "vite"
export default (): Plugin => ({
  name: "fixture",
  config(config) {
    let entries = config.resolve?.dedupe
    entries = ["vue"]
    return { resolve: { dedupe: [...entries, "x"] } }
  },
})`,
    ],
    [
      "a helper name that is declared twice",
      `import type { Plugin } from "vite"
function outer() {
  function merge(current: string[]) {
    return [...current, "x"]
  }
  return merge
}
function merge(current: string[]) {
  return current.includes("x") ? undefined : ["x"]
}
export default (): Plugin => ({
  name: "fixture",
  config(config) {
    return { resolve: { dedupe: merge(config.resolve.dedupe) } }
  },
})`,
    ],
    [
      "a reassigned hook parameter",
      `import type { Plugin } from "vite"
export default (): Plugin => ({
  name: "fixture",
  config(config) {
    config = { resolve: { dedupe: ["vue"] } }
    return { resolve: { dedupe: [...config.resolve.dedupe, "x"] } }
  },
})`,
    ],
    [
      "cyclic aliases",
      `import type { Plugin } from "vite"
export default (): Plugin => ({
  name: "fixture",
  config(config) {
    const a = b
    const b = a
    return { resolve: { dedupe: [...a, "x"] } }
  },
})`,
    ],
    [
      "a helper that reassigns its parameter",
      `import type { Plugin } from "vite"
function merge(current: string[]) {
  current = ["x"]
  return [...current, "y"]
}
export default (): Plugin => ({
  name: "fixture",
  config(config) {
    return { resolve: { dedupe: merge(config.resolve.dedupe) } }
  },
})`,
    ],
    [
      "a Vite require that only appears in a comment",
      `// const vite = require("vite")
export const store = {
  name: "store",
  config(config) {
    return { items: [...config.items, "x"] }
  },
}`,
    ],
    [
      "an imported helper that shares a name with a nested function",
      `import type { Plugin } from "vite"
import { merge } from "./merge"
function other() {
  function merge(current: string[]) {
    return [...current, "x"]
  }
  return merge
}
export default (): Plugin => ({
  name: "fixture",
  config(config) {
    return { resolve: { dedupe: merge(config.resolve.dedupe) } }
  },
})`,
    ],
  ])("accepts %s", async (_label, source) => {
    const result = await run(source);
    expect(result.diagnostics).toEqual([]);
  });

  test("reports configEnvironment plugins without a Vite import", async () => {
    const result = await run(`export default () => ({
  name: "fixture",
  configEnvironment(name, config) {
    return { resolve: { dedupe: [...config.resolve.dedupe, "x"] } }
  },
})`);
    expect(result.diagnostics).toHaveLength(1);
  });

  test("reports CommonJS plugins that require Vite tooling", async () => {
    const result = await run(`const { mergeConfig } = require("vite")
module.exports = () => ({
  name: "fixture",
  config(config) {
    return { resolve: { dedupe: [...config.resolve.dedupe, "x"] } }
  },
})`);
    expect(result.diagnostics).toHaveLength(1);
  });

  test("is Recommended and documents VITE0026", async () => {
    expect(viteRulePack.presets?.recommended).toContain(noConfigHookArrayEcho.meta.id);
    expect(getDiagnosticDocuments()).toContainEqual(
      expect.objectContaining({
        code: "VITE0026",
        ruleId: noConfigHookArrayEcho.meta.id,
        path: "/diagnostics/VITE0026",
      }),
    );
    const page = await diagnosticsCollectionSource.getItem("diagnostics/VITE0026.md");
    expect(page).toContain("mergeConfig");
  });
});
