import { expect, test } from "vite-plus/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { createProjectFixture, runProjectFixture } from "../../../src/core/testkit.ts";
import { createJsonReport } from "../../../src/core/reports.ts";
import type { DoctorConfig } from "../../../src/core/index.ts";
import {
  nitroRulePack,
  noModuleScopeResponseCache,
  noRequestDataInModuleState,
} from "../../../src/rule-packs/nitro/index.ts";

async function run(
  files: Record<string, string>,
  framework: "nuxt" | "nitro" = "nuxt",
  rules = [noRequestDataInModuleState],
  config?: DoctorConfig,
) {
  const result = await runProjectFixture({ framework, files, rules, config });
  return result.diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    file: diagnostic.file?.replace(/^.*\/(?:vue-doctor|vite-doctor-fixture)-[^/]+\//, ""),
    line: diagnostic.range?.line,
  }));
}

test("uses only reachable logical operands as copy evidence", async () => {
  const file = "server/api/session.get.ts";
  expect(
    await run({
      [file]: `const and = {}
const or = {}
const nullish = {}
const inline = {}
const spread = {}
const live = {}
const fallback = {}
export default defineEventHandler((event) => {
  const useCookieLocale = false
  const localeOverride = 'en'
  const skipped = { current: useCookieLocale && getCookie(event, 'locale') }
  Object.assign(and, skipped)
  Object.assign(or, { ...{ current: localeOverride || getCookie(event, 'locale') } })
  const patch = { current: localeOverride ?? getCookie(event, 'locale') }
  Object.assign(nullish, patch)
  Object.assign(inline, { current: false && getCookie(event, 'locale') })
  Object.assign(spread, { ...skipped })
  const enabled = (useCookieLocale && event.context) || true
  const livePatch = { current: enabled && getCookie(event, 'locale') }
  Object.assign(live, livePatch)
  const cookiePatch = { current: getCookie(event, 'locale') ?? 'en' }
  Object.assign(fallback, { ...cookiePatch })
})`,
    }),
  ).toEqual([6, 7].map((line) => ({ code: "NITRO0035", file, line })));
});

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

const cacheFile = "server/api/me.get.ts";
const cacheFiles = {
  [cacheFile]: `let cached: { user: unknown, expiresAt: number } | null = null
export default defineEventHandler(async (event) => {
  if (cached && cached.expiresAt > Date.now()) return cached.user
  cached = { user: await $fetch('/users/me', { headers: getRequestHeaders(event) }), expiresAt: Date.now() + 60_000 }
  return cached.user
})`,
};
const cacheRules = [noRequestDataInModuleState, noModuleScopeResponseCache];

test("reports a hand-rolled cache once next to NITRO0023", async () => {
  const file = cacheFile;
  const files = cacheFiles;
  const both = cacheRules;
  const fallback = [{ code: "NITRO0023", file, line: 1 }];
  expect(await run(files, "nuxt", both)).toEqual([{ code: "NITRO0035", file, line: 1 }]);
  expect(await run(files, "nuxt", [noModuleScopeResponseCache])).toEqual(fallback);
  const off = { [noRequestDataInModuleState.meta.id]: "off" } as const;
  expect(await run(files, "nuxt", both, { rules: off })).toEqual(fallback);
  expect(await run(files, "nuxt", both, { overrides: [{ files: [file], rules: off }] })).toEqual(
    fallback,
  );
});

test("retains the highest configured severity for an overlapping cache finding", async () => {
  const result = await runProjectFixture({
    framework: "nuxt",
    files: cacheFiles,
    rules: cacheRules,
    config: {
      rules: {
        [noModuleScopeResponseCache.meta.id]: "error",
        [noRequestDataInModuleState.meta.id]: "warn",
      },
    },
  });
  expect(result.diagnostics).toMatchObject([{ code: "NITRO0023", severity: "error" }]);
});

test("uses the same overlapping finding in reports and baselines", async () => {
  const fixture = createProjectFixture({ framework: "nuxt", files: cacheFiles });
  const dir = await mkdtemp(join(tmpdir(), "doctor-module-state-baseline-"));
  const baseline = join(dir, "baseline.json");
  const rules = cacheRules;
  try {
    const result = await fixture.run({ rules });
    expect(result.diagnostics).toMatchObject([{ code: "NITRO0035" }]);
    await writeFile(baseline, createJsonReport(result));
    const filtered = await fixture.run({ rules, run: { baseline, newOnly: true } });
    expect(filtered.diagnostics).toEqual([]);
    expect(filtered.suppressedDiagnostics).toMatchObject([{ code: "NITRO0035" }]);
    await fixture.run({ rules, run: { baseline, updateBaseline: true } });
    expect(JSON.parse(await readFile(baseline, "utf8")).diagnostics).toMatchObject([
      { fingerprint: result.diagnostics[0]!.fingerprint },
    ]);

    const previous = await fixture.run({
      rules,
      config: { rules: { [noModuleScopeResponseCache.meta.id]: "error" } },
    });
    expect(previous.diagnostics).toMatchObject([{ code: "NITRO0023" }]);
    await writeFile(baseline, createJsonReport(previous));
    const changedWinner = await fixture.run({ rules, run: { baseline, newOnly: true } });
    expect(changedWinner.diagnostics.map(({ code }) => code)).toEqual(["NITRO0035"]);
  } finally {
    await fixture.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reports only fixed-key writes, including const aliases and direct event storage", async () => {
  const file = "server/api/rooms/[id].post.ts";
  expect(
    await run({
      [file]: `const fixed = new Map()
const direct = new Map()
const rooms = {}
const indexed = {}
const assigned = {}
const key = 'current'
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  fixed.set(key, event.context)
  direct.set('current', event)
  Object.assign(rooms, { [id]: await readBody(event), [getQuery(event).q]: 42 })
  const alias = key
  indexed[alias] = event.context
  Object.assign(assigned, { [id]: 0, [alias]: event })
})`,
    }),
  ).toEqual([1, 2, 4, 5].map((line) => ({ code: "NITRO0035", file, line })));
});

test("ships in the Recommended Preset", () => {
  expect(nitroRulePack.presets.recommended).toContain(noRequestDataInModuleState.meta.id);
});

test("finds fixed keys in locally declared Object.assign sources and object spreads", async () => {
  const file = "server/api/session.get.ts";
  expect(
    await run({
      [file]: `const aliased = {}
const spread = {}
const keyed = {}
export default defineEventHandler((event) => {
  const patch = { current: getCookie(event, 'session') }
  const alias = patch
  const byId = { [getQuery(event).id]: event.context.user }
  Object.assign(aliased, alias, { other: 'public' })
  Object.assign(spread, { ...patch, ...{ current: event.context.user } })
  Object.assign(keyed, { ...byId })
})`,
    }),
  ).toEqual([1, 2].map((line) => ({ code: "NITRO0035", file, line })));
});

test("finds the same scalar fallback in inline, named, and spread copy sources", async () => {
  const file = "server/api/session.get.ts";
  expect(
    await run({
      [file]: `const inline = {}
const named = {}
const spread = {}
export default defineEventHandler((event) => {
  const patch = { current: getCookie(event, 'sort') ?? 'default' }
  Object.assign(inline, { current: getCookie(event, 'sort') ?? 'default' })
  Object.assign(named, patch)
  Object.assign(spread, { ...patch })
})`,
    }),
  ).toEqual([1, 2, 3].map((line) => ({ code: "NITRO0035", file, line })));
});

test.each([
  [
    "a property read before the copy",
    "const current = patch.current; Object.assign(shared, patch); return current",
  ],
  ["a property read after the copy", "Object.assign(shared, patch); return patch.current"],
  ["an overwrite after the copy", "Object.assign(shared, patch); patch.current = 'public'"],
  [
    "an overwrite through an alias after the copy",
    "const alias = patch; Object.assign(shared, alias); patch.current = 'public'",
  ],
  [
    "an overwrite after a spread snapshot",
    "const snapshot = { ...patch }; patch.current = 'public'; Object.assign(shared, snapshot)",
  ],
])("reports request data copied by Object.assign with %s", async (_, copy) => {
  const file = "server/api/session.get.ts";
  expect(
    await run({
      [file]: `const shared = {}
export default defineEventHandler((event) => {
  const patch = { current: getCookie(event, 'session') }
  ${copy}
})`,
    }),
  ).toEqual([{ code: "NITRO0035", file, line: 1 }]);
});

test.each([
  ["a later property", "Object.assign(shared, { ...patch, ['current']: 'public' })"],
  ["a later spread", "Object.assign(shared, { ...patch, ...{ current: 'public' } })"],
  ["a later source", "Object.assign(shared, patch, { current: 'public' })"],
  ["a direct mutation", "patch.current = 'public'; Object.assign(shared, patch)"],
  [
    "a mutation through an alias",
    "const alias = patch; alias.current = 'public'; Object.assign(shared, patch)",
  ],
  ["a possible mutation in another function", "rewrite(patch); Object.assign(shared, patch)"],
  [
    "a called closure declared after the copy",
    "rewrite(); Object.assign(shared, patch); function rewrite() { patch.current = 'public' }",
  ],
  ["a method that overwrites its receiver", "patch.clear(); Object.assign(shared, patch)"],
  [
    "an overwrite in another source argument",
    "Object.assign(shared, patch, (patch.current = 'public', {}))",
  ],
  [
    "a call to a shadowed Object.assign",
    "{ const Object = { assign: (_, value) => { value.current = 'public' } }; Object.assign({}, patch) }; Object.assign(shared, patch)",
  ],
])("does not report overwritten Object.assign data after %s", async (_, copy) => {
  expect(
    await run({
      "server/api/session.get.ts": `const shared = {}
export default defineEventHandler((event) => {
  const patch = { current: getCookie(event, 'session'), clear() { this.current = 'public' } }
  ${copy}
})`,
    }),
  ).toEqual([]);
});

test.each([
  ["a nested write", "patch.current.sort = 'default'; Object.assign(shared, patch)", false],
  [
    "a nested alias escape",
    "const current = patch.current; rewrite(current); Object.assign(shared, patch)",
    false,
  ],
  [
    "a nested write after a shallow snapshot",
    "const snapshot = { ...patch }; patch.current.sort = 'default'; Object.assign(shared, snapshot)",
    false,
  ],
  [
    "a write through a different shallow copy",
    "const other = { ...patch }; other.current.sort = 'default'; Object.assign(shared, patch)",
    false,
  ],
  ["an unexposed source", "Object.assign(shared, patch)", true],
  ["an unexposed snapshot", "Object.assign(shared, { ...patch })", true],
])("checks nested Object.assign values with %s", async (_, copy, reports) => {
  const file = "server/api/session.get.ts";
  expect(
    await run({
      [file]: `const shared = {}
const rewrite = (value) => { value.sort = 'default' }
export default defineEventHandler((event) => {
  const patch = { current: { sort: getCookie(event, 'sort') } }
  ${copy}
})`,
    }),
  ).toEqual(reports ? [{ code: "NITRO0035", file, line: 1 }] : []);
});

test("keeps scalar copy evidence when a sibling nested value escapes", async () => {
  const file = "server/api/session.get.ts";
  expect(
    await run({
      [file]: `const shared = {}
export default defineEventHandler((event) => {
  const patch = { current: { sort: getQuery(event).sort }, session: getCookie(event, 'session') ?? 'public' }
  patch.current.sort = 'default'
  Object.assign(shared, { ...patch })
})`,
    }),
  ).toEqual([{ code: "NITRO0035", file, line: 1 }]);
});

test("does not treat a fallback that can return a mutable value as scalar", async () => {
  expect(
    await run({
      "server/api/session.get.ts": `const shared = {}
export default defineEventHandler((event) => {
  const fallback = { sort: getQuery(event).sort }
  const patch = { current: getCookie(event, 'sort') ?? fallback }
  fallback.sort = 'default'
  if (typeof patch.current === 'object') Object.assign(shared, { ...patch })
})`,
    }),
  ).toEqual([]);
});
