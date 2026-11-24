import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import {
  nitroRulePack,
  requireWaitUntilForBackgroundWork,
} from "../../../src/rule-packs/nitro/index.ts";

const cloudflareNuxt = {
  "nuxt.config.ts": "export default defineNuxtConfig({ nitro: { preset: 'cloudflare_module' } })\n",
};

async function run(
  files: Record<string, string>,
  framework: "nuxt" | "nitro" = "nuxt",
  dependencies?: Record<string, string>,
) {
  const result = await runRuleFixture({
    rule: requireWaitUntilForBackgroundWork,
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
  expect(nitroRulePack.presets.recommended).toContain(requireWaitUntilForBackgroundWork.meta.id);
});

test("reports unawaited $fetch and storage writes on a Cloudflare preset", async () => {
  const diagnostics = await run({
    ...cloudflareNuxt,
    "server/api/orders.post.ts": `export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const storage = useStorage('data')
  $fetch('https://hooks.example.com/order', { method: 'POST', body })
  storage.setItem('last-order', body)
  void useStorage('data').removeItem('draft')
  if (body.notify)
    $fetch('/api/notify', { method: 'POST' }).catch(() => {})
  return { ok: true }
})
`,
  });
  expect(diagnostics).toEqual([
    { code: "NITRO0033", file: "server/api/orders.post.ts", line: 4 },
    { code: "NITRO0033", file: "server/api/orders.post.ts", line: 5 },
    { code: "NITRO0033", file: "server/api/orders.post.ts", line: 6 },
    { code: "NITRO0033", file: "server/api/orders.post.ts", line: 8 },
  ]);
});

test("reports imported Nitro fetch APIs on a Nitro 3 Vercel preset", async () => {
  const diagnostics = await run(
    {
      "nitro.config.ts":
        "export default defineConfig({ scanDirs: ['./server'], preset: 'vercel' })\n",
      "server/routes/track.ts": `import { defineHandler } from "nitro/h3"
import { fetch as request, serverFetch } from 'nitro/app'
const track = (event) => {
  request('/_track', { method: 'POST' })
  serverFetch('/_track', { method: 'POST' })
  event.fetch('/_track')
  return 'ok'
}
export default defineHandler(track)
`,
    },
    "nitro",
    { nitro: "^3.0.0" },
  );
  expect(diagnostics).toEqual([
    { code: "NITRO0033", file: "server/routes/track.ts", line: 4 },
    { code: "NITRO0033", file: "server/routes/track.ts", line: 5 },
  ]);
});

test.each([
  ["awaited", "await $fetch('/hook', { method: 'POST' })"],
  ["passed to event.waitUntil", "event.waitUntil($fetch('/hook', { method: 'POST' }))"],
  ["returned", "return $fetch('/hook', { method: 'POST' })"],
  ["assigned", "const pending = $fetch('/hook', { method: 'POST' })\n  await pending"],
  ["a synchronous call", "console.log('order')"],
  ["started in a nested callback", "setTimeout(() => $fetch('/hook'), 0)"],
  ["a local $fetch", "const $fetch = (url: string) => console.log(url)\n  $fetch('/hook')"],
] as const)("stays quiet when the promise is %s", async (_, statement) => {
  const diagnostics = await run({
    ...cloudflareNuxt,
    "server/api/orders.post.ts": `export default defineEventHandler(async (event) => {\n  ${statement}\n  return { ok: true }\n})\n`,
  });
  expect(diagnostics).toEqual([]);
});

const floating = `export default defineEventHandler(async (event) => {
  $fetch('/hook', { method: 'POST' })
  return { ok: true }
})
`;

test("checks production routes and retains Nitro 2 event.fetch", async () => {
  const source = floating.replace("$fetch", "event.fetch");
  expect(
    await run({
      ...cloudflareNuxt,
      "server/api/demo.dev.ts": source,
      "server/api/demo.prod.ts": source,
    }),
  ).toEqual([{ code: "NITRO0033", file: "server/api/demo.prod.ts", line: 2 }]);
});

test.each([
  ["", { build: "nitro build", note: "echo NITRO_PRESET=cloudflare_module" }],
  ["preset: 'cloudflare-module'", { build: "NITRO_PRESET=$TARGET nitro build" }],
])("does not assume a preset with scripts %j %j", async (config, scripts) => {
  expect(
    await run(
      {
        "nitro.config.ts": `export default { ${config} }`,
        "package.json": JSON.stringify({
          name: "fixture",
          dependencies: { nitropack: "^2.13.4" },
          scripts,
        }),
        "routes/track.ts": floating,
      },
      "nitro",
    ),
  ).toEqual([]);
});

test.each([
  ["no preset", { "nuxt.config.ts": "export default defineNuxtConfig({})\n" }],
  [
    "a Node.js preset",
    { "nuxt.config.ts": "export default defineNuxtConfig({ nitro: { preset: 'node-server' } })\n" },
  ],
  [
    "Vercel on Nitro 2, which does not forward waitUntil",
    { "nuxt.config.ts": "export default defineNuxtConfig({ nitro: { preset: 'vercel' } })\n" },
  ],
  [
    "a preset read from a variable",
    {
      "nuxt.config.ts":
        "const preset = process.env.PRESET\nexport default defineNuxtConfig({ nitro: { preset } })\n",
    },
  ],
  [
    "a build script that overrides the preset",
    {
      ...cloudflareNuxt,
      "package.json": JSON.stringify({
        name: "fixture",
        private: true,
        scripts: { build: "NITRO_PRESET=node-server nuxt build" },
        dependencies: { vue: "^3.5.0", nuxt: "^4.0.0" },
      }),
    },
  ],
] as const)("stays quiet with %s", async (_, files) => {
  expect(await run({ ...files, "server/api/orders.post.ts": floating })).toEqual([]);
});
