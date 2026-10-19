import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { nitroRulePack, noUnguardedAlsEnterWith } from "../../../src/rule-packs/nitro/index.ts";

// packages/rate-limit/src/runtime/state.ts in vitehub before 0fe572417.
const unguarded = `import { AsyncLocalStorage } from "node:async_hooks"

const runtimeEventStorage = new AsyncLocalStorage<unknown>()

export function runWithRateLimitRuntimeEvent<T>(event: unknown, callback: () => T): T {
  return runtimeEventStorage.run(event, callback)
}

export function enterRateLimitRuntimeEvent(event: unknown): void {
  runtimeEventStorage.enterWith(event)
}
`;

// packages/queue/src/internal/runtime/state.ts in vitehub.
const guarded = `import { AsyncLocalStorage } from "node:async_hooks"

const queueEventStorage = new AsyncLocalStorage<unknown>()

export function enterQueueRuntimeEvent(event: unknown): void {
  try {
    queueEventStorage.enterWith(event)
  }
  catch {}
}
`;

async function run(
  files: Record<string, string>,
  dependencies?: Record<string, string>,
  framework: "nitro" | "nuxt" = "nitro",
) {
  const result = await runRuleFixture({
    rule: noUnguardedAlsEnterWith,
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
  expect(nitroRulePack.presets.recommended).toContain(noUnguardedAlsEnterWith.meta.id);
});

test("reports an unguarded enterWith when the package depends on wrangler", async () => {
  expect(await run({ "src/runtime/state.ts": unguarded }, { wrangler: "^4.0.0" })).toEqual([
    { code: "NITRO0024", file: "src/runtime/state.ts", line: 10 },
  ]);
});

test.each([
  ["a wrangler config", { "wrangler.jsonc": '{ "name": "app" }' }, "nitro"],
  [
    "a cloudflare Nitro preset",
    { "nitro.config.ts": "export default defineNitroConfig({ preset: 'cloudflare-module' })" },
    "nitro",
  ],
  [
    "a cloudflare preset in a CommonJS Nitro config",
    { "nitro.config.cjs": "module.exports = { preset: 'cloudflare-pages' }" },
    "nitro",
  ],
  [
    "a cloudflare Nuxt preset",
    {
      "nuxt.config.ts":
        "export default defineNuxtConfig({ nitro: { preset: 'cloudflare_module' } })",
    },
    "nuxt",
  ],
] as const)("reports with %s", async (_, files, framework) => {
  const diagnostics = await run(
    { ...files, "server/utils/state.ts": unguarded },
    undefined,
    framework,
  );
  expect(diagnostics).toMatchObject([{ code: "NITRO0024", file: "server/utils/state.ts" }]);
});

test("reports files that import cloudflare: modules", async () => {
  const source = `import { env } from "cloudflare:workers"\n${unguarded}`;
  expect(await run({ "src/state.ts": source })).toMatchObject([{ code: "NITRO0024" }]);
});

test.each([
  ["a side-effect import", 'import "cloudflare:workers"'],
  ["a dynamic import", 'const workers = await import("cloudflare:workers")'],
  ["a require call", 'const workers = require("cloudflare:workers")'],
])("reports files that load cloudflare: modules through %s", async (_, line) => {
  expect(await run({ "src/state.ts": `${line}\n${unguarded}` })).toMatchObject([
    { code: "NITRO0024" },
  ]);
});

test("reports workspace packages that declare a cloudflare keyword", async () => {
  const diagnostics = await run({
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "packages/rate-limit/package.json": JSON.stringify({
      name: "@vite-hub/rate-limit",
      keywords: ["rate-limit", "cloudflare"],
    }),
    "packages/rate-limit/src/runtime/state.ts": unguarded,
    "packages/kv/package.json": JSON.stringify({ name: "@vite-hub/kv" }),
    "packages/kv/src/runtime/state.ts": unguarded,
  });
  expect(diagnostics).toEqual([
    { code: "NITRO0024", file: "packages/rate-limit/src/runtime/state.ts", line: 10 },
  ]);
});

test.each([
  [
    "a catch that rethrows",
    "try {\n    storage.enterWith(event)\n  }\n  catch (error) {\n    throw error\n  }",
  ],
  [
    "a try around a callback",
    "try {\n    queueMicrotask(() => storage.enterWith(event))\n  }\n  catch {}",
  ],
  ["a try/finally", "try {\n    storage.enterWith(event)\n  }\n  finally {}"],
  ["optional chaining", "storage?.enterWith(event)"],
  ["a computed member", 'storage["enterWith"](event)'],
  ["a template literal member", "storage[`enterWith`](event)"],
  [
    "a catch that logs and rethrows",
    "try {\n    storage.enterWith(event)\n  }\n  catch (error) {\n    console.error(error)\n    throw new Error('enter failed', { cause: error })\n  }",
  ],
  [
    "a catch with a conditional return before rethrow",
    "try {\n    storage.enterWith(event)\n  }\n  catch (error) {\n    if (shouldIgnore) return\n    throw error\n  }",
  ],
])("reports %s", async (_, body) => {
  const source = `import { AsyncLocalStorage } from "node:async_hooks"
const storage = new AsyncLocalStorage<unknown>()
export function enter(event: unknown) {
  ${body}
}`;
  expect(await run({ "src/state.ts": source }, { wrangler: "^4.0.0" })).toMatchObject([
    { code: "NITRO0024" },
  ]);
});

test.each([
  ["guarded calls", { "src/runtime/state.ts": guarded }, { wrangler: "^4.0.0" }],
  ["projects without a Cloudflare target", { "src/runtime/state.ts": unguarded }, undefined],
  [
    "a commented-out cloudflare preset",
    {
      "nitro.config.ts":
        "export default defineNitroConfig({\n  // preset: 'cloudflare-pages',\n  /* preset: 'cloudflare-module' */\n  preset: 'node-server',\n})",
      "server/utils/state.ts": unguarded,
    },
    undefined,
  ],
  ["test files", { "test/runtime.test.ts": unguarded }, { wrangler: "^4.0.0" }],
  [
    "a call inside a function invoked synchronously within try",
    {
      "src/runtime/state.ts": `import { AsyncLocalStorage } from "node:async_hooks"
const storage = new AsyncLocalStorage<unknown>()
export function enter(event: unknown) {
  try {
    ;(() => storage.enterWith(event))()
  } catch {}
}`,
    },
    { wrangler: "^4.0.0" },
  ],
  [
    "enterWith() in files that never reference AsyncLocalStorage",
    {
      "src/runtime/router.ts": `export function enterSection(router: { enterWith(value: string): void }) {
  router.enterWith("settings")
}`,
    },
    { wrangler: "^4.0.0" },
  ],
  [
    "run()",
    {
      "src/runtime/state.ts": `import { AsyncLocalStorage } from "node:async_hooks"
const storage = new AsyncLocalStorage<unknown>()
export const runWithEvent = <T>(event: unknown, callback: () => T) => storage.run(event, callback)`,
    },
    { wrangler: "^4.0.0" },
  ],
] as const)("does not report %s", async (_, files, dependencies) => {
  expect(await run({ ...files }, dependencies ? { ...dependencies } : undefined)).toEqual([]);
});
