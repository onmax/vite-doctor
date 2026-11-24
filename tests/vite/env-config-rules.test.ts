import { describe, expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../src/core/testkit.ts";
import {
  noBroadEnvPrefix,
  noClientSecretPattern,
  noEmptyEnvPrefix,
  noLoadEnvAllInDefine,
  noRuntimeObjectDefine,
  noUnprefixedClientEnv,
  noUnreachableHook,
  noUntypedEnv,
  viteRulePack,
} from "../../src/rules.ts";

const config = (body: string) => `import { defineConfig } from 'vite'
export default defineConfig(${body})`;

async function run(
  rules: Parameters<typeof runProjectFixture>[0]["rules"],
  files: Record<string, string>,
  framework: "vite" | "nuxt" = "vite",
) {
  const result = await runProjectFixture({ framework, rules, files });
  return result.diagnostics.map(({ code, why }) => `${code}: ${why}`).sort();
}

describe("vite/env/no-unprefixed-client-env", () => {
  test("is recommended", () => {
    expect(viteRulePack.presets?.recommended).toContain("vite/env/no-unprefixed-client-env");
  });

  test.each([
    ["the default prefix", config("{}"), "API_URL"],
    ["a custom prefix", config("{ envPrefix: 'APP_' }"), "VITE_API_URL"],
    ["a prefix list", config("{ envPrefix: ['APP_', 'PUBLIC_'] }"), "API_URL"],
  ])("reports an unprefixed read under %s", async (_, viteConfig, name) => {
    const diagnostics = await run([noUnprefixedClientEnv], {
      "vite.config.ts": viteConfig,
      "src/main.ts": `console.log(import.meta.env.${name})`,
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatch(
      new RegExp(`^VITE0030: import\\.meta\\.env\\.${name} is undefined`),
    );
  });

  test("keeps prefixed keys, built-ins and define keys quiet", async () => {
    expect(
      await run([noUnprefixedClientEnv], {
        "vite.config.ts": config(`{
  envPrefix: ['VITE_', 'APP_'],
  define: { 'import.meta.env.API_URL': JSON.stringify('https://example.com') },
}`),
        "src/main.ts": `console.log(
  import.meta.env.VITE_API_URL,
  import.meta.env.APP_NAME,
  import.meta.env.API_URL,
  import.meta.env.MODE,
  import.meta.env.DEV,
  import.meta.env.PROD,
  import.meta.env.SSR,
  import.meta.env.BASE_URL,
)`,
        "src/App.test.ts": "console.log(import.meta.env.API_URL)",
      }),
    ).toEqual([]);
  });

  test.each([
    ["a dynamic envPrefix", config("{ envPrefix: process.env.PREFIX }")],
    ["a spread define", config("{ define: { ...defines } }")],
    ["a whole import.meta.env define", config("{ define: { 'import.meta.env': {} } }")],
    [
      "a merged config",
      "import { mergeConfig } from 'vite'\nimport base from './base'\nexport default mergeConfig(base, {})",
    ],
  ])("records a gap for %s", async (_, viteConfig) => {
    expect(
      await run([noUnprefixedClientEnv], {
        "vite.config.ts": viteConfig,
        "src/main.ts": "console.log(import.meta.env.API_URL)",
      }),
    ).toEqual([]);
  });

  test("stays quiet without a Vite config, in Nuxt, and with env plugins", async () => {
    const source = { "src/main.ts": "console.log(import.meta.env.API_URL)" };
    expect(await run([noUnprefixedClientEnv], source)).toEqual([]);
    expect(
      await run(
        [noUnprefixedClientEnv],
        {
          ...source,
          "nuxt.config.ts": "export default defineNuxtConfig({})",
          "vite.config.ts": config("{}"),
        },
        "nuxt",
      ),
    ).toEqual([]);
    expect(
      await run([noUnprefixedClientEnv], {
        ...source,
        "vite.config.ts": config("{}"),
        "package.json": JSON.stringify({ devDependencies: { "vite-plugin-environment": "1.0.0" } }),
      }),
    ).toEqual([]);
  });

  test("leaves secret-looking names to VITE0009 and untyped hints to the unexposed check", async () => {
    expect(
      await run([noUnprefixedClientEnv, noClientSecretPattern, noUntypedEnv], {
        "vite.config.ts": config("{}"),
        "src/main.ts": "console.log(import.meta.env.API_URL, import.meta.env.DB_PASSWORD)",
      }),
    ).toEqual([
      "VITE0009: import.meta.env.DB_PASSWORD looks like a secret and may be exposed to the browser.",
      expect.stringMatching(/^VITE0030: import\.meta\.env\.API_URL is undefined/),
    ]);
  });

  test("VITE0011 still reports untyped keys Vite exposes", async () => {
    expect(
      await run([noUnprefixedClientEnv, noUntypedEnv], {
        "vite.config.ts": config("{}"),
        "src/main.ts": "console.log(import.meta.env.VITE_API_URL)",
      }),
    ).toEqual([
      "VITE0011: import.meta.env.VITE_API_URL is used but not declared on ImportMetaEnv.",
    ]);
  });
});

describe("vite/define/no-loadenv-all-in-define", () => {
  test("is recommended", () => {
    expect(viteRulePack.presets?.recommended).toContain("vite/define/no-loadenv-all-in-define");
  });

  test.each([
    ["'process.env': env"],
    ["'import.meta.env': env"],
    ["'process.env': JSON.stringify(env)"],
    ["...env"],
    ["'process.env': process.env"],
    ["'process.env': { ...env }"],
  ])("reports define { %s }", async (entry) => {
    const diagnostics = await run([noLoadEnvAllInDefine], {
      "vite.config.ts": `import { defineConfig, loadEnv } from 'vite'
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return { define: { ${entry} } }
})`,
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatch(/^VITE0031: /);
  });

  test("replaces the VITE0004 stringify advice for whole-env values", async () => {
    expect(
      await run([noLoadEnvAllInDefine, noRuntimeObjectDefine], {
        "vite.config.ts": `import { defineConfig, loadEnv } from 'vite'
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return { define: { 'process.env': env, __FLAGS__: { beta: true } } }
})`,
      }),
    ).toEqual([
      'VITE0004: Vite define "__FLAGS__" uses a non-primitive replacement value.',
      expect.stringMatching(/^VITE0031: Vite define "process\.env" receives every variable/),
    ]);
  });

  test("reports an inline loadEnv call with a prefix list containing ''", async () => {
    expect(
      await run([noLoadEnvAllInDefine], {
        "vite.config.ts": `import * as vite from 'vite'
export default vite.defineConfig(({ mode }) => ({
  define: { 'process.env': vite.loadEnv(mode, process.cwd(), ['VITE_', '']) },
}))`,
      }),
    ).toHaveLength(1);
  });

  test.each([
    [
      "one public value",
      "const env = loadEnv(mode, process.cwd(), '')",
      "__API__: JSON.stringify(env.API_URL)",
    ],
    ["the default prefix", "const env = loadEnv(mode, process.cwd())", "'process.env': env"],
    [
      "a narrow prefix",
      "const env = loadEnv(mode, process.cwd(), 'PUBLIC_')",
      "'process.env': env",
    ],
    ["an unknown prefix", "const env = loadEnv(mode, process.cwd(), prefix)", "'process.env': env"],
    [
      "an indirect copy",
      "const env = { ...loadEnv(mode, process.cwd(), '') }",
      "'process.env': env",
    ],
    ["a shadowed process", "const process = { env: {} }", "'process.env': process.env"],
  ])("stays quiet for %s", async (_, setup, entry) => {
    expect(
      await run([noLoadEnvAllInDefine], {
        "vite.config.ts": `import { defineConfig, loadEnv } from 'vite'
export default defineConfig(({ mode }) => {
  ${setup}
  return { define: { ${entry} } }
})`,
      }),
    ).toEqual([]);
  });
});

describe("vite/plugin/no-unreachable-hook", () => {
  test("is recommended", () => {
    expect(viteRulePack.presets?.recommended).toContain("vite/plugin/no-unreachable-hook");
  });

  test.each(["configureServer", "configurePreviewServer", "handleHotUpdate", "hotUpdate"])(
    "reports %s on a build-only plugin",
    async (hook) => {
      const diagnostics = await run([noUnreachableHook], {
        "vite.config.ts": config(`{
  plugins: [{
    name: 'local',
    apply: 'build',
    ${hook}() {},
  }],
}`),
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatch(new RegExp(`^VITE0032: Vite never calls ${hook}`));
    },
  );

  test("reports hooks in local plugin files with handler objects", async () => {
    expect(
      await run([noUnreachableHook], {
        "plugins/local.ts": `import type { Plugin } from 'vite'
export function local(): Plugin {
  return { name: 'local', apply: 'build', configureServer: { order: 'pre', handler() {} } }
}`,
      }),
    ).toHaveLength(1);
  });

  test.each([
    [
      "serve plugins with serve hooks",
      "apply: 'serve', configureServer() {}, configurePreviewServer() {}",
    ],
    [
      "build plugins with hooks that run in build",
      "apply: 'build', transformIndexHtml() {}, generateBundle() {}",
    ],
    [
      "serve plugins with build output hooks",
      "apply: 'serve', generateBundle() {}, closeBundle() {}",
    ],
    ["function apply", "apply: (_, env) => env.command === 'build', configureServer() {}"],
    ["dynamic apply", "apply: command, configureServer() {}"],
    ["spread plugins", "...base, apply: 'build', configureServer() {}"],
  ])("stays quiet for %s", async (_, body) => {
    expect(
      await run([noUnreachableHook], {
        "vite.config.ts": config(`{ plugins: [{ name: 'local', ${body} }] }`),
      }),
    ).toEqual([]);
  });
});

describe("vite/env/no-empty-env-prefix", () => {
  test("says Vite rejects the config and leaves the empty prefix to VITE0010", async () => {
    expect(
      await run([noEmptyEnvPrefix, noBroadEnvPrefix], {
        "vite.config.ts": config("{ envPrefix: ['', 'VITE_'] }"),
      }),
    ).toEqual([
      expect.stringMatching(
        /^VITE0010: Vite throws while resolving a config whose envPrefix contains ""/,
      ),
    ]);
  });
});
