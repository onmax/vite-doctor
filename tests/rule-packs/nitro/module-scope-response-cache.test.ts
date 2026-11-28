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
  [
    "an age compared with a TTL",
    `const cache = new Map<string, { value: unknown, at: number }>()
const TTL = 60_000
export async function load(key: string) {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL) return hit.value
  const value = await $fetch('/value')
  cache.set(key, { value, at: Date.now() })
  return value
}`,
  ],
  [
    "an age from a clock local, with the TTL on the left",
    `let snapshot: { rows: string[], fetchedAt: number } | undefined
export async function getRows() {
  const now = Date.now()
  if (snapshot && 30_000 >= (now - snapshot.fetchedAt)) return snapshot.rows
  const rows = await $fetch<string[]>('/rows')
  snapshot = { rows, fetchedAt: now }
  return rows
}`,
  ],
])("reports %s", async (_, source) => {
  const diagnostics = await run({ "server/utils/cache.ts": source });
  expect(diagnostics).toMatchObject([{ code: "NITRO0023", file: "server/utils/cache.ts" }]);
});

const fresh = "hit && Date.now() - hit.at < 60_000";
const stale = "!hit || 60_000 <= Date.now() - hit.at";
const refresh = `const value = await $fetch('/value')
  cache.set(key, { value, at: Date.now() })
  return value`;

function ageCache(body: string, keySetup = "") {
  return `const cache = new Map<string, { value: unknown, at: number }>()
export async function load(key: string) {
  const hit = cache.get(key)
  ${keySetup}
  ${body}
}`;
}

test.each([
  ["an explicit refresh branch", `if (${fresh}) return hit.value; else { ${refresh} }`],
  ["an explicit stale-or-missing branch", `if (${stale}) { ${refresh} } else return hit.value`],
  ["a stale-or-missing early return", `if (${stale}) { ${refresh} }\nreturn hit.value`],
  [
    "logging before a hit return",
    `if (${fresh}) { console.debug('hit'); return hit.value }\n${refresh}`,
  ],
  [
    "logging before the refresh write",
    `if (${fresh}) return hit.value\n${refresh.replace("cache.set", "console.debug('refresh'); cache.set")}`,
  ],
])("reports age-based reuse with %s", async (_, body) => {
  expect(await run({ "server/utils/cache.ts": ageCache(body) })).toMatchObject([
    { code: "NITRO0023" },
  ]);
});

test.each([
  ["at function scope", "", ""],
  ["inside a try block", "try {", "} catch (error) { throw error }"],
])("reports a Map key normalized before lookup %s", async (_, open, close) => {
  const source = ageCache(`if (${fresh}) return hit.value\n${refresh}\n${close}`).replace(
    "const hit = cache.get(key)",
    `${open}\n  key = key.trim().toLowerCase()\n  const hit = cache.get(key)`,
  );
  expect(await run({ "server/utils/cache.ts": source })).toMatchObject([{ code: "NITRO0023" }]);
});

test.each(["const", "let"])("reports a %s Map key declared alongside the lookup", async (kind) => {
  const source = ageCache(`if (${fresh}) return hit.value\n${refresh}`)
    .replace("load(key: string)", "load(slug: string)")
    .replace("const hit = cache.get(key)", `${kind} key = slug.trim(), hit = cache.get(key)`);
  expect(await run({ "server/utils/cache.ts": source })).toMatchObject([{ code: "NITRO0023" }]);
});

test.each([
  ["in a for-of header", "for (const key of candidates)", ""],
  ["in the loop body", "for (const candidate of candidates)", "const key = candidate.trim()"],
])("reports same-iteration reuse with a Map key initialized %s", async (_, loop, setup) => {
  const source = `const cache = new Map<string, { value: unknown, at: number }>()
export async function load(candidates: string[]) {
  ${loop} {
    ${setup}
    try {
      const hit = cache.get(key)
      if (${fresh}) return hit.value
      ${refresh}
    } catch (error) {
      throw error
    }
  }
}`;
  expect(await run({ "server/utils/cache.ts": source })).toMatchObject([{ code: "NITRO0023" }]);
});

test("reports cross-iteration reuse with a Map key initialized once in a for header", async () => {
  const source = `const cache = new Map<string, { value: unknown, at: number }>()
export async function load(candidate: string) {
  let attempt = 0
  for (const key = candidate.trim(); key; attempt++) {
    if (attempt === 0) {
      var hit = cache.get(key)
      continue
    }
    if (${fresh}) return hit.value
    ${refresh}
  }
}`;
  expect(await run({ "server/utils/cache.ts": source })).toMatchObject([{ code: "NITRO0023" }]);
});

test.each([
  ["in the loop header", "const key", "['public:' + slug, 'internal:' + slug]", ""],
  ["in the loop body", "const prefix", "['public:', 'internal:']", "const key = prefix + slug"],
])(
  "does not match Map keys across iterations when initialized %s",
  async (_, binding, keys, setup) => {
    const source = `const cache = new Map<string, { value: unknown, at: number }>()
export async function load(slug: string) {
  for (${binding} of ${keys}) {
    ${setup}
    if (key.startsWith('public:')) {
      var hit = cache.get(key)
      continue
    }
    if (${fresh}) return hit.value
    ${refresh}
  }
}`;
    expect(await run({ "server/utils/cache.ts": source })).toEqual([]);
  },
);

test("reports age-based reuse in a loop with a key initialized outside it", async () => {
  const source = `const cache = new Map<string, { value: unknown, at: number }>()
export async function load(slug: string) {
  const key = slug.trim()
  for (let attempt = 0; attempt < 2; attempt++) {
    const hit = cache.get(key)
    if (${fresh}) return hit.value
    ${refresh}
  }
}`;
  expect(await run({ "server/utils/cache.ts": source })).toMatchObject([{ code: "NITRO0023" }]);
});

test("does not report a Map key changed by a later initializer in the lookup declaration", async () => {
  const source = ageCache(`if (${fresh}) return hit.value\n${refresh}`)
    .replace("load(key: string)", "load(slug: string)")
    .replace(
      "const hit = cache.get(key)",
      "let key = slug.trim(), hit = cache.get(key), next = (key = 'internal:' + key)",
    );
  expect(await run({ "server/utils/cache.ts": source })).toEqual([]);
});

test("does not report age-based reuse when a closure can change the Map key", async () => {
  const source = ageCache(`if (${fresh}) return hit.value\nchangeKey()\n${refresh}`).replace(
    "const hit = cache.get(key)",
    "const changeKey = () => { key = 'internal:' + key }\n  const hit = cache.get(key)",
  );
  expect(await run({ "server/utils/cache.ts": source })).toEqual([]);
});

test.each([
  ["a reassigned", `if (${fresh}) return hit.value\n${refresh}`, "key = 'internal:' + key"],
  ["a shadowed", `if (${fresh}) return hit.value; else { const key = 'internal'; ${refresh} }`, ""],
  ["a reinitialized", `if (${fresh}) return hit.value\n${refresh}`, "var key = 'internal:' + key"],
])("does not report age-based reuse with %s Map key", async (_, body, keySetup) => {
  expect(await run({ "server/utils/cache.ts": ageCache(body, keySetup) })).toEqual([]);
});

test("does not report a stale branch that refreshes but still returns the old hit", async () => {
  const source = ageCache(
    `if (${stale}) { ${refresh.replace("return value", "")} }\nreturn hit?.value`,
  );
  expect(await run({ "server/utils/cache.ts": source })).toEqual([]);
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
  [
    "a helper whose cache parameter is shadowed",
    `const moduleCache = new Map<string, { value: unknown, expiresAt: number }>()
function inspect(cache: Map<string, { value: unknown, expiresAt: number }>, key: string) {
  {
    const cache = new Map<string, { value: unknown, expiresAt: number }>()
    const entry = cache.get(key)
    if (entry && entry.expiresAt > Date.now()) return entry.value
  }
  return null
}
export async function load(key: string) {
  inspect(moduleCache, key)
  const value = await $fetch('/value')
  moduleCache.set(key, { value, expiresAt: 0 })
  return value
}`,
  ],
  [
    "a nested function with a shadowed cached entry",
    `const cache = new Map<string, { value: unknown, expiresAt: number }>()
export async function load(key: string) {
  const hit = cache.get(key)
  const unrelated = () => {
    const hit = { expiresAt: Date.now() + 1000 }
    return hit.expiresAt > Date.now()
  }
  await unrelated()
  const value = await $fetch('/value')
  cache.set(key, { value, expiresAt: Date.now() + 1000 })
  return value
}`,
  ],
  [
    "a clock local declared in a nested function",
    `let now = 0
const cache = new Map<string, { value: unknown, expiresAt: number }>()
export async function load(key: string) {
  const metrics = () => {
    const now = Date.now()
    return now
  }
  const hit = cache.get(key)
  if (hit && hit.expiresAt > now) return hit.value
  const value = await $fetch('/value')
  cache.set(key, { value, expiresAt: metrics() + 1000 })
  return value
}`,
  ],
  [
    "a synchronous rate-limit window measured by age",
    `const hits = new Map<string, { count: number, at: number }>()
export function allow(ip: string) {
  const now = Date.now()
  const entry = hits.get(ip)
  if (!entry || now - entry.at > 60_000) {
    hits.set(ip, { count: 1, at: now })
    return true
  }
  entry.count++
  return entry.count <= 10
}`,
  ],
  [
    "an age check that only logs a stale hit",
    `const cache = new Map<string, { value: unknown, at: number }>()
export async function load(key: string) {
  const hit = cache.get(key)
  if (hit) {
    if (Date.now() - hit.at > 60_000) console.warn('old hit')
    return hit.value
  }
  const value = await $fetch('/value')
  cache.set(key, { value, at: Date.now() })
  return value
}`,
  ],
  [
    "an age-based rate limiter with an unrelated await",
    `const hits = new Map<string, { count: number, at: number, auditId: string }>()
export async function countHits(ip: string) {
  const now = Date.now()
  const entry = hits.get(ip)
  if (entry && now - entry.at < 60_000) return entry.count
  const auditId = await audit(ip)
  hits.set(ip, { count: 1, at: now, auditId })
  return 1
}`,
  ],
  [
    "a throttle measured by age",
    `let lastCall = 0
export async function ping() {
  if (Date.now() - lastCall < 1000) return
  lastCall = Date.now()
  await $fetch('/ping')
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
