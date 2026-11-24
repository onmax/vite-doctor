import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { nitroRulePack, noRuntimeConfigInResponse } from "../../../src/rule-packs/nitro/index.ts";

async function run(
  files: Record<string, string>,
  framework: "nuxt" | "nitro" = "nuxt",
  dependencies?: Record<string, string>,
) {
  const result = await runRuleFixture({
    rule: noRuntimeConfigInResponse,
    framework,
    dependencies,
    files,
  });
  return result.diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    file: diagnostic.file?.replace(/^.*\/(?:vue-doctor|vite-doctor-fixture)-[^/]+\//, ""),
    line: diagnostic.range?.line,
  }));
}

test("ships in the Recommended Preset", () => {
  expect(nitroRulePack.presets.recommended).toContain(noRuntimeConfigInResponse.meta.id);
});

test.each([
  "export default () => useRuntimeConfig()",
  "import { defineHandler as route } from 'nitro/h3'; const handle = () => useRuntimeConfig(); export default route(handle)",
])("finds registered handlers under scanDirs: %s", async (source) => {
  expect(
    await run(
      {
        "nitro.config.ts": "export default { scanDirs: ['./custom'] }",
        "custom/routes/config.ts": source,
      },
      "nitro",
      { nitro: "^3.0.0" },
    ),
  ).toHaveLength(1);
});

test.each([
  "config && config.public",
  "JSON.stringify(config, ['public', 'siteUrl'])",
  "new Response(Response.json(config))",
  "({ debug: config, ...{ debug: false } })",
  "({ debug: config, debug: false })",
])("does not report discarded or filtered config: %s", async (response) => {
  expect(
    await run({
      "server/api/config.ts": `export default defineEventHandler(() => {
    const config = useRuntimeConfig()
    return ${response}
  })`,
    }),
  ).toEqual([]);
});

test.each([
  "const keys = ['public', 'siteUrl']; return JSON.stringify(config, keys)",
  "return JSON.stringify(config, (_, value) => ({ public: value.public }))",
  "return JSON.stringify(config, (_, value) => value)",
  "const keys = ['public']; keys.push(...Object.keys(config)); return JSON.stringify(config, keys)",
  "return JSON.stringify(config, [...Object.keys(config)])",
  "const override = { debug: false }; return { debug: config, ...override }",
  "const override = { debug: false }; Reflect.deleteProperty(override, 'debug'); return { debug: config, ...override }",
  "const override = { debug: false }; Reflect.deleteProperty(override, 'debug'); return { ...{ debug: config }, ...override }",
  "const override = { debug: false }; return { debug: config, ...{ ...override } }",
  "return { debug: config, [String('debug')]: false }",
  "return { ...config, ...config.public }",
])("does not report when the whole-config flow is unknown: %s", async (body) => {
  expect(
    await run({
      "server/api/config.ts": `export default defineEventHandler(() => {
    const config = useRuntimeConfig()
    ${body}
  })`,
    }),
  ).toEqual([]);
});

test.each([
  "return JSON.stringify(config)",
  "return JSON.stringify(config, null, 2)",
  "return new Response(JSON.stringify(config, undefined, 2))",
  "return { ...{ debug: config } }",
  "const override = { debug: false }; return { ...override, debug: config }",
  "const override = { debug: false }; return { debug: config, ...override, cfg: config }",
  "const response = { previous: false ? { ...response } : null }; return { ...response, cfg: config }",
])("reports proven whole-config flows: %s", async (body) => {
  expect(
    await run({
      "server/api/config.ts": `export default defineEventHandler(() => {
    const config = useRuntimeConfig()
    ${body}
  })`,
    }),
  ).toEqual([{ code: "NITRO0032", file: "server/api/config.ts", line: 3 }]);
});

test("ignores unused handler factories", async () => {
  expect(
    await run({
      "server/api/config.ts": `const debug = defineEventHandler(() => useRuntimeConfig())
    export default defineEventHandler(() => 'ok')`,
    }),
  ).toEqual([]);
});

test.each([
  [
    "the useRuntimeConfig() call",
    "export default defineEventHandler((event) => {\n  return useRuntimeConfig(event)\n})\n",
    2,
  ],
  ["an arrow body", "export default defineEventHandler(event =>\n  useRuntimeConfig(event))\n", 2],
  [
    "a const bound to the config",
    "export default defineEventHandler((event) => {\n  const config = useRuntimeConfig(event)\n  return config\n})\n",
    3,
  ],
  [
    "a spread of the config",
    "export default defineEventHandler(async (event) => {\n  const config = useRuntimeConfig(event)\n  return { ok: true,\n    ...config }\n})\n",
    4,
  ],
  [
    "the config nested in the response",
    "export default defineEventHandler((event) => {\n  const config = useRuntimeConfig(event)\n  return { debug: { config } }\n})\n",
    3,
  ],
  [
    "a module-scope const",
    "const config = useRuntimeConfig()\n\nexport default defineEventHandler(() => {\n  return JSON.stringify(config)\n})\n",
    4,
  ],
] as const)("reports a handler that returns %s", async (_, source, line) => {
  expect(await run({ "server/api/config.get.ts": source })).toEqual([
    { code: "NITRO0032", file: "server/api/config.get.ts", line },
  ]);
});

test("reports an imported useRuntimeConfig in a Nitro 3 handler", async () => {
  const diagnostics = await run(
    {
      "nitro.config.ts": "export default defineConfig({ serverDir: './server' })\n",
      "server/routes/config.ts": `import { defineHandler } from "nitro/h3"
import { useRuntimeConfig } from "nitro/runtime-config"

export default defineHandler(() => Response.json(useRuntimeConfig()))
`,
    },
    "nitro",
    { nitro: "^3.0.0" },
  );
  expect(diagnostics).toEqual([{ code: "NITRO0032", file: "server/routes/config.ts", line: 4 }]);
});

test.each([
  [
    "a public value",
    "export default defineEventHandler((event) => {\n  const config = useRuntimeConfig(event)\n  return { site: config.public.site }\n})\n",
  ],
  [
    "the public group",
    "export default defineEventHandler((event) => useRuntimeConfig(event).public)\n",
  ],
  [
    "a spread of the public group",
    "export default defineEventHandler((event) => {\n  const config = useRuntimeConfig(event)\n  return { ...config.public }\n})\n",
  ],
  [
    "a value computed from a secret",
    "export default defineEventHandler(async (event) => {\n  const config = useRuntimeConfig(event)\n  return await $fetch('/api', { headers: { authorization: config.apiSecret } })\n})\n",
  ],
] as const)("stays quiet when the handler returns %s", async (_, source) => {
  expect(await run({ "server/api/config.get.ts": source })).toEqual([]);
});

test.each([
  [
    "a local useRuntimeConfig",
    "const useRuntimeConfig = () => ({ site: 'docs' })\n\nexport default defineEventHandler(() => useRuntimeConfig())\n",
  ],
  [
    "a useRuntimeConfig imported from another module",
    "import { useRuntimeConfig } from '~/server/utils/safe-config'\n\nexport default defineEventHandler(() => useRuntimeConfig())\n",
  ],
  [
    "a reassigned binding",
    "export default defineEventHandler((event) => {\n  let config = useRuntimeConfig(event)\n  config = { site: config.public.site }\n  return config\n})\n",
  ],
  [
    "a config returned from a nested callback",
    "export default defineEventHandler((event) => {\n  const config = useRuntimeConfig(event)\n  const read = () => config\n  return { site: read().public.site }\n})\n",
  ],
  [
    "a helper outside any handler",
    "export function readConfig() {\n  return useRuntimeConfig()\n}\n",
  ],
] as const)("stays quiet for %s", async (_, source) => {
  expect(await run({ "server/api/config.get.ts": source })).toEqual([]);
});

test("stays quiet outside server code", async () => {
  expect(
    await run({
      "app/composables/config.ts":
        "export default defineEventHandler((event) => useRuntimeConfig(event))\n",
    }),
  ).toEqual([]);
});
