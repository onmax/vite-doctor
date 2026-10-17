import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { nitroRulePack, noModuleScopeResponseCache } from "../../../src/rule-packs/nitro/index.ts";

async function run(files: Record<string, string>, framework: "nuxt" | "nitro" = "nuxt") {
  const result = await runRuleFixture({ rule: noModuleScopeResponseCache, framework, files });
  return result.diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    file: diagnostic.file?.replace(/^.*\/(?:vue-doctor|vite-doctor-fixture)-[^/]+\//, ""),
    line: diagnostic.range?.line,
  }));
}

test("is a Strict-only Nitro rule", () => {
  expect(nitroRulePack.presets.strict).toContain(noModuleScopeResponseCache.meta.id);
  expect(nitroRulePack.presets.recommended).not.toContain(noModuleScopeResponseCache.meta.id);
});

test("reports a Map cache filled through the request user's client", async () => {
  const diagnostics = await run({
    "server/api/kpis/index.post.ts": `const labelCache = new Map<string, { labels: Map<string, string>, expiry: number }>()
const LABEL_CACHE_TTL = 60_000

async function resolveLabels(groupCode: string) {
  const cached = labelCache.get(groupCode)
  if (cached && cached.expiry > Date.now())
    return cached.labels
  const labels = new Map<string, string>()
  const { data } = await getRequestDirectus().items('productattribute').readByQuery({ filter: { groupCode } })
  for (const item of data) labels.set(item.code, item.name)
  labelCache.set(groupCode, { labels, expiry: Date.now() + LABEL_CACHE_TTL })
  return labels
}

export default defineEventHandler(async (event) => resolveLabels(getRouterParam(event, 'group')!))
`,
  });
  expect(diagnostics).toEqual([
    { code: "NITRO0023", file: "server/api/kpis/index.post.ts", line: 1 },
  ]);
});

test.each([
  [
    "a let cache with a clock local",
    `let flowNodesCache: { expiresAt: number, nodes: string[] } | null = null

export async function getAvailableFlowNodes() {
  const now = Date.now()
  if (flowNodesCache && flowNodesCache.expiresAt > now)
    return [...flowNodesCache.nodes]
  const nodes = await $fetch<string[]>('/openapi.json')
  flowNodesCache = { nodes, expiresAt: now + 60_000 }
  return nodes
}`,
  ],
  [
    "Maps passed to read and write helpers",
    `interface Entry<T> { expiresAt: number, value: T }
const suppliersCache = new Map<string, Entry<string[]>>()

function readCache<T>(cache: Map<string, Entry<T>>, key: string) {
  const entry = cache.get(key)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key)
    return null
  }
  return entry.value
}

function writeCache<T>(cache: Map<string, Entry<T>>, key: string, value: T) {
  cache.set(key, { expiresAt: Date.now() + 60_000, value })
}

export async function loadSuppliers(key: string) {
  const cached = readCache(suppliersCache, key)
  if (cached) return cached
  const data = await $fetch<string[]>('/suppliers')
  writeCache(suppliersCache, key, data)
  return data
}`,
  ],
  [
    "a Map filled in a promise continuation",
    `const planningGroupsCache = new Map<string, { expiresAt: number, value: string[] }>()

export async function loadPlanningGroups(key: string) {
  const hit = planningGroupsCache.get(key)
  const groups = hit && hit.expiresAt > Date.now()
    ? hit.value
    : await $fetch<string[]>('/planning-groups').then((data) => {
        planningGroupsCache.set(key, { expiresAt: Date.now() + 60_000, value: data })
        return data
      })
  return groups
}`,
  ],
  [
    "a Map declared with let",
    `let cache = new Map<string, { value: unknown, expiresAt: number }>()
export async function load(key: string) {
  const hit = cache.get(key)
  if (hit && hit.expiresAt > Date.now()) return hit.value
  const value = await $fetch('/value')
  cache.set(key, { value, expiresAt: Date.now() + 1000 })
  return value
}`,
  ],
  [
    "an expiry read with new Date().getTime()",
    `const cache = new Map<string, { value: unknown, expiresAt: number }>()
export async function load(key: string) {
  const hit = cache.get(key)
  if (hit && hit.expiresAt > new Date().getTime()) return hit.value
  const value = await $fetch('/value')
  cache.set(key, { value, expiresAt: new Date().getTime() + 1000 })
  return value
}`,
  ],
  [
    "an expiry read straight from Map#get",
    `const cache = new Map<string, { value: unknown, expiresAt: number }>()
export async function load(key: string) {
  if ((cache.get(key)?.expiresAt ?? 0) > Date.now()) return cache.get(key)!.value
  const value = await $fetch('/value')
  cache.set(key, { value, expiresAt: Date.now() + 1000 })
  return value
}`,
  ],
  [
    "a Map filled in a synchronous callback of an async function",
    `const cache = new Map<string, { value: unknown, expiresAt: number }>()
export async function load(key: string) {
  const hit = cache.get(key)
  if (hit && hit.expiresAt > Date.now()) return hit.value
  const rows = await $fetch<unknown[]>('/rows')
  rows.forEach((row) => cache.set(key, { value: row, expiresAt: Date.now() + 1000 }))
  return rows
}`,
  ],
])("reports %s", async (_, source) => {
  const diagnostics = await run({ "server/utils/cache.ts": source });
  expect(diagnostics).toMatchObject([{ code: "NITRO0023", file: "server/utils/cache.ts" }]);
});

test("reports standalone Nitro server code", async () => {
  const diagnostics = await run(
    {
      "server/routes/labels.get.ts": `const cache = new Map<string, { value: unknown, expiresAt: number }>()
export default defineEventHandler(async () => {
  const hit = cache.get('labels')
  if (hit && hit.expiresAt > Date.now()) return hit.value
  const value = await $fetch('https://example.com/labels')
  cache.set('labels', { value, expiresAt: Date.now() + 1000 })
  return value
})`,
      "nitro.config.ts": "export default defineNitroConfig({ srcDir: 'server' })",
    },
    "nitro",
  );
  expect(diagnostics).toMatchObject([{ code: "NITRO0023" }]);
});

test.each([
  [
    "defineCachedFunction",
    `export const getLabels = defineCachedFunction(
  async (group: string) => $fetch<string[]>(\`/labels/\${group}\`),
  { name: 'labels', maxAge: 60, getKey: (group: string) => group },
)`,
  ],
  [
    "a synchronous rate-limit window",
    `const hits = new Map<string, { count: number, resetAt: number }>()
export function allow(ip: string) {
  const now = Date.now()
  const entry = hits.get(ip)
  if (!entry || entry.resetAt < now) {
    hits.set(ip, { count: 1, resetAt: now + 60_000 })
    return true
  }
  entry.count++
  return entry.count <= 10
}`,
  ],
  [
    "a throttle timestamp",
    `let lastCall = 0
export async function ping() {
  if (lastCall + 1000 > Date.now()) return
  lastCall = Date.now()
  await $fetch('/ping')
}`,
  ],
  [
    "a cache without expiry",
    `const schemas = new Map<string, unknown>()
export async function getSchema(name: string) {
  if (schemas.has(name)) return schemas.get(name)
  const schema = await $fetch(\`/schemas/\${name}\`)
  schemas.set(name, schema)
  return schema
}`,
  ],
  [
    "shadowed locals",
    `const cache = new Map<string, { value: unknown, expiresAt: number }>()
export async function load(key: string) {
  const cache = new Map<string, { value: unknown, expiresAt: number }>()
  const hit = cache.get(key)
  if (hit && hit.expiresAt > Date.now()) return hit.value
  const value = await $fetch('/value')
  cache.set(key, { value, expiresAt: Date.now() + 1000 })
  return value
}`,
  ],
  [
    "WeakMaps",
    `const cache = new WeakMap<object, { value: unknown, expiresAt: number }>()
export async function load(owner: object) {
  const hit = cache.get(owner)
  if (hit && hit.expiresAt > Date.now()) return hit.value
  const value = await $fetch('/value')
  cache.set(owner, { value, expiresAt: Date.now() + 1000 })
  return value
}`,
  ],
])("does not report %s", async (_, source) => {
  expect(await run({ "server/utils/cache.ts": source })).toEqual([]);
});

test("does not report Nuxt 4 app/server files, which Nitro does not scan", async () => {
  const source = `const cache = new Map<string, { value: unknown, expiresAt: number }>()
export async function load(key: string) {
  const hit = cache.get(key)
  if (hit && hit.expiresAt > Date.now()) return hit.value
  const value = await $fetch('/value')
  cache.set(key, { value, expiresAt: Date.now() + 1000 })
  return value
}`;
  expect(await run({ "app/server/utils/cache.ts": source })).toEqual([]);
});

test("does not report app code or server tests", async () => {
  const source = `const cache = new Map<string, { value: unknown, expiresAt: number }>()
export async function load(key: string) {
  const hit = cache.get(key)
  if (hit && hit.expiresAt > Date.now()) return hit.value
  const value = await $fetch('/value')
  cache.set(key, { value, expiresAt: Date.now() + 1000 })
  return value
}`;
  expect(
    await run({
      "app/composables/useValue.ts": source,
      "server/utils/cache.test.ts": source,
    }),
  ).toEqual([]);
});
