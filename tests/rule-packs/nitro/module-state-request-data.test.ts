import { expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import {
  nitroRulePack,
  noModuleScopeResponseCache,
  noRequestDataInModuleState,
} from "../../../src/rule-packs/nitro/index.ts";

async function run(
  files: Record<string, string>,
  framework: "nuxt" | "nitro" = "nuxt",
  rules = [noRequestDataInModuleState],
) {
  const result = await runProjectFixture({ framework, files, rules });
  return result.diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    file: diagnostic.file?.replace(/^.*\/(?:vue-doctor|vite-doctor-fixture)-[^/]+\//, ""),
    line: diagnostic.range?.line,
  }));
}

test.each([
  [
    "a module let assigned from the request query in a route",
    "server/api/search.get.ts",
    `let lastSearch = ''
export default defineEventHandler((event) => {
  const { q } = getQuery(event)
  lastSearch = String(q)
  return searchProducts(lastSearch)
})`,
  ],
  [
    "a module object written from the session cookie in middleware",
    "server/middleware/auth.ts",
    `import { defineEventHandler, getCookie } from 'h3'
const auth = { userId: '' }
export default defineEventHandler((event) => {
  auth.userId = getCookie(event, 'user-id') ?? ''
})`,
  ],
  [
    "a module object filled from event.context in a server util",
    "server/utils/tenant.ts",
    `import type { H3Event } from 'h3'
export const current = { tenant: '' }
export function selectTenant(event: H3Event) {
  current.tenant = event.context.tenant
}`,
  ],
  [
    "a Map written under a constant key from the request body",
    "server/api/settings.post.ts",
    `const settings = new Map<string, unknown>()
export default defineEventHandler(async (event) => {
  settings.set('current', await readBody(event))
})`,
  ],
  [
    "an object handler with a lazy initializer",
    "server/routes/locale.ts",
    `let locale: string | undefined
export default defineEventHandler({
  handler(event) {
    locale ??= getHeader(event, 'accept-language')
    return locale
  },
})`,
  ],
])("reports %s", async (_, file, source) => {
  const line = source.split("\n").findIndex((text) => /^(?:export )?(?:const|let) /.test(text)) + 1;
  expect(await run({ [file]: source })).toEqual([{ code: "NITRO0035", file, line }]);
});

test("reports routes in a standalone Nitro project", async () => {
  expect(
    await run(
      {
        "routes/me.ts": `let viewer: unknown
export default eventHandler((event) => {
  viewer = event.context.user
  return viewer
})`,
      },
      "nitro",
    ),
  ).toEqual([{ code: "NITRO0035", file: "routes/me.ts", line: 1 }]);
});

test.each([
  [
    "request-scoped storage on event.context",
    "server/middleware/auth.ts",
    `export default defineEventHandler((event) => {
  event.context.userId = getCookie(event, 'user-id')
})`,
  ],
  [
    "a cache keyed and written from constants",
    "server/api/config.get.ts",
    `const cache: { config?: unknown } = {}
export default defineEventHandler(async () => {
  cache.config ??= await $fetch('https://cms.example.com/config')
  return cache.config
})`,
  ],
  [
    "a store keyed by the request",
    "server/api/rooms/[id].post.ts",
    `const rooms = new Map<string, unknown>()
const votes: Record<string, number> = {}
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  rooms.set(id, await readBody(event))
  votes[id] = (votes[id] ?? 0) + 1
})`,
  ],
  [
    "an event passed to a helper",
    "server/api/me.get.ts",
    `let config: unknown
export default defineEventHandler((event) => {
  config = useRuntimeConfig(event)
  return config
})`,
  ],
  [
    "a request getter that is not h3's",
    "server/api/search.get.ts",
    `import { getQuery } from './query'
let lastSearch: unknown
export default defineEventHandler(() => {
  lastSearch = getQuery()
})`,
  ],
  [
    "a value whose origin the file cannot show",
    "server/utils/viewer.ts",
    `let viewer: unknown
export function rememberViewer(user: unknown) {
  viewer = user
}`,
  ],
  [
    "a let only reassigned at module scope",
    "server/api/hello.ts",
    `let greeting = 'hello'
greeting = greeting.toUpperCase()
export default defineEventHandler(() => greeting)`,
  ],
  [
    "files outside the server directory",
    "shared/utils/search.ts",
    `let lastSearch: unknown
export function track(event: any) {
  lastSearch = getQuery(event)
}`,
  ],
  [
    "server tests",
    "server/api/search.test.ts",
    `let lastSearch: unknown
export default defineEventHandler((event) => {
  lastSearch = getQuery(event)
})`,
  ],
])("does not report %s", async (_, file, source) => {
  expect(await run({ [file]: source })).toEqual([]);
});

test("reports a hand-rolled cache once next to NITRO0023", async () => {
  const file = "server/api/me.get.ts";
  const diagnostics = await run(
    {
      [file]: `let cached: { user: unknown, expiresAt: number } | null = null
export default defineEventHandler(async (event) => {
  if (cached && cached.expiresAt > Date.now()) return cached.user
  cached = { user: await $fetch('/users/me', { headers: getRequestHeaders(event) }), expiresAt: Date.now() + 60_000 }
  return cached.user
})`,
    },
    "nuxt",
    [noRequestDataInModuleState, noModuleScopeResponseCache],
  );
  expect(diagnostics).toEqual([{ code: "NITRO0035", file, line: 1 }]);
});

test("ships in the Recommended Preset", () => {
  expect(nitroRulePack.presets.recommended).toContain(noRequestDataInModuleState.meta.id);
});
