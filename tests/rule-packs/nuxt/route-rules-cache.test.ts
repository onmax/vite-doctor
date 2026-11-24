import { expect, test } from "vite-plus/test";
import { runProjectFixture, runRuleFixture } from "../../../src/core/testkit.ts";
import nuxtRulePack from "../../../src/rule-packs/nuxt/rules/nuxt.ts";
import { noPersonalizedCachedHandler } from "../../../src/rule-packs/nuxt/rules/nuxthub.ts";

const RULE_ID = "nuxt/ssr/no-request-state-in-cached-page";
const rules = nuxtRulePack.rules.filter((rule) => rule.meta.id === RULE_ID);

const autoImports = [
  ...["useRequestHeaders", "useRequestHeader", "useRequestEvent"].map((name) => ({
    name,
    from: "#app/composables/ssr",
  })),
  { name: "useCookie", from: "#app/composables/cookie" },
  { name: "useRequestURL", from: "#app/composables/url" },
  { name: "onMounted", from: "vue" },
];

function manifest(pages: Array<{ path: string; file: string }>, routeRules: object, evidence = {}) {
  return JSON.stringify({
    generatedAt: "2100-01-01T00:00:00.000Z",
    appDir: "app",
    autoImportEnabled: true,
    autoImports,
    pages,
    routeRules,
    resolvedRouteRules: routeRules,
    routeRulePageMtimes: {},
    ...evidence,
  });
}

async function run(files: Record<string, string>) {
  const result = await runProjectFixture({ framework: "nuxt", files, rules });
  return {
    diagnostics: result.diagnostics
      .filter((diagnostic) => diagnostic.code === "NUXT0106")
      .map((diagnostic) => ({
        file: diagnostic.file?.replace(/^.*\/(?:vue-doctor|vite-doctor-fixture)-[^/]+\//, ""),
        line: diagnostic.range?.line,
        why: diagnostic.why,
        evidence: diagnostic.evidence,
      })),
    gaps: (result.project.evidenceGaps ?? []).filter(
      (gap) => gap.source === "vite-doctor/nuxt-route-rules",
    ),
  };
}

const page = (script: string, template = "<div />") =>
  `<script setup lang="ts">\n${script}\n</script>\n<template>${template}</template>\n`;

test.each([
  [
    "request headers on a swr page",
    "/account",
    { "/account": { swr: 60 } },
    "const headers = useRequestHeaders(['cookie'])",
    "swr",
  ],
  [
    "a cookie on an ISR page targeting Vercel",
    "/blog/featured",
    { "/blog/featured": { isr: 60 } },
    "const session = useCookie('session')",
    "isr",
    '<a v-if="session">Sign out</a>',
  ],
  [
    "the request event context on a prerendered page",
    "/dashboard",
    { "/dashboard": { prerender: true } },
    "const user = useRequestEvent()?.context.user",
    "prerender",
  ],
  [
    "request headers through a local event on a cached page",
    "/pricing",
    { "/pricing": { cache: { maxAge: 600 } } },
    "const event = useRequestEvent()\nconst country = event?.headers.get('cf-ipcountry')",
    "cache",
  ],
  [
    "the query of a prerendered page",
    "/search",
    { "/search": { prerender: true } },
    "const q = useRequestURL().searchParams.get('q')",
    "prerender",
  ],
])("reports %s", async (_name, route, routeRules, script, kind, template?: string) => {
  const file = `app/pages${route}.vue`;
  const result = await run({
    [file]: page(script, template),
    ".nuxt/doctor.manifest.json": manifest([{ path: route, file }], routeRules, {
      nitroPreset: "vercel",
    }),
  });

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({ file, line: script.split("\n").length + 1 });
  expect(result.diagnostics[0]?.why).toContain(kind);
  expect(result.diagnostics[0]?.evidence?.[0]).toMatchObject({ kind: "manifest" });
});

test.each([
  ["the page has no cache rule", { "/other": { swr: 60 } }, "useRequestHeaders(['cookie'])"],
  [
    "a more specific rule turns the cache off",
    { "/account/**": { swr: 60 }, "/account": { cache: false } },
    "useRequestHeaders(['cookie'])",
  ],
  [
    "a route rule renders the page only in the browser",
    { "/account": { swr: 60, ssr: false } },
    "useRequestHeaders(['cookie'])",
  ],
  [
    "the cache varies on request headers",
    { "/account": { cache: { maxAge: 60, varies: ["cookie"] } } },
    "useRequestHeaders(['cookie'])",
  ],
  [
    "the cache varies on the header read from event.headers",
    { "/account": { cache: { varies: ["X-Theme"] } } },
    "useRequestEvent()?.headers.get('x-theme')",
  ],
  [
    "the read runs after mount",
    { "/account": { swr: 60 } },
    "onMounted(() => { const headers = useRequestHeaders(['cookie']) })",
  ],
  [
    "the read is guarded by import.meta.client",
    { "/account": { swr: 60 } },
    "if (import.meta.client) { const theme = useCookie('theme') }",
  ],
  [
    "a cached page reads the query, which Nitro keeps in the cache key",
    { "/account": { swr: 60 } },
    "const q = useRequestURL().searchParams.get('q')",
  ],
  [
    "a cookie that only an event handler uses",
    { "/account": { swr: 60 } },
    "const theme = useCookie('theme')\nconst toggle = () => { theme.value = 'dark' }",
  ],
  [
    "the route params of the request event",
    { "/account": { swr: 60 } },
    "const id = useRequestEvent()?.context.params?.id",
  ],
  ["a redirect rule only", { "/account": { redirect: "/login" } }, "useRequestHeaders(['cookie'])"],
])("stays quiet when %s", async (_name, routeRules, script) => {
  const result = await run({
    "app/pages/account.vue": page(script),
    ".nuxt/doctor.manifest.json": manifest(
      [{ path: "/account", file: "app/pages/account.vue" }],
      routeRules,
    ),
  });

  expect(result.diagnostics).toEqual([]);
});

test("stays quiet for the same read in a component that is not a page", async () => {
  const result = await run({
    "app/components/AccountMenu.vue": page("useRequestHeaders(['cookie'])"),
    ".nuxt/doctor.manifest.json": manifest([{ path: "/account", file: "app/pages/account.vue" }], {
      "/**": { swr: 60 },
    }),
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.gaps).toEqual([]);
});

test("records an evidence gap when the route rules cannot be resolved", async () => {
  const withoutManifest = await run({
    "nuxt.config.ts":
      "export default defineNuxtConfig({ routeRules: { '/account': { swr: 60 } } })",
    "app/pages/account.vue": page("useRequestHeaders(['cookie'])"),
  });
  const catchAll = await run({
    "app/pages/docs/[...slug].vue": page("useRequestHeaders(['cookie'])"),
    ".nuxt/doctor.manifest.json": manifest(
      [{ path: "/docs/:slug(.*)*", file: "app/pages/docs/[...slug].vue" }],
      { "/docs/**": { swr: 60 } },
    ),
  });

  expect(withoutManifest.diagnostics).toEqual([]);
  expect(withoutManifest.gaps).toHaveLength(1);
  expect(catchAll.diagnostics).toEqual([]);
  expect(catchAll.gaps[0]?.message).toContain("/docs/:slug(.*)*");
});

test("is in the recommended preset", () => {
  expect(nuxtRulePack.presets.recommended).toContain(RULE_ID);
});

test.each([
  [{ isr: 60 }, "node-server"],
  [{ swr: 60, redirect: { to: "/login" } }, undefined],
  [{ swr: 60, proxy: { to: "/proxy" } }, undefined],
])("does not report an inactive page cache: %j", async (rules, nitroPreset) => {
  const file = "app/pages/account.vue";
  const result = await run({
    [file]: page("useRequestHeaders(['cookie'])"),
    ".nuxt/doctor.manifest.json": manifest(
      [{ path: "/account", file }],
      { "/account": rules },
      { nitroPreset },
    ),
  });
  expect(result.diagnostics).toEqual([]);
});

test("an unknown production preset leaves ISR coverage unresolved", async () => {
  const file = "app/pages/account.vue";
  const result = await run({
    [file]: page("useRequestHeaders(['cookie'])"),
    ".nuxt/doctor.manifest.json": manifest([{ path: "/account", file }], {
      "/account": { isr: 60 },
    }),
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.gaps[0]?.message).toContain("ISR coverage");
});

test.each([
  ["/blog/:slug()", "/blog/featured"],
  ["/blog/:id(\\d+)", "/blog/_"],
])("does not claim cache coverage from a sample URL for %s", async (path, pattern) => {
  const file = "app/pages/blog/[slug].vue";
  const result = await run({
    [file]: page("useRequestHeaders(['cookie'])"),
    ".nuxt/doctor.manifest.json": manifest([{ path, file }], { [pattern]: { swr: 60 } }),
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.gaps).toHaveLength(1);
});

test("page inputs that changed invalidate route evidence across files", async () => {
  const file = "app/pages/account.vue";
  const other = "app/pages/other.vue";
  const result = await run({
    [file]: page("useRequestHeaders(['cookie'])"),
    [other]: page("defineRouteRules({ cache: false })"),
    ".nuxt/doctor.manifest.json": manifest(
      [
        { path: "/account", file },
        { path: "/other", file: other },
      ],
      { "/account": { swr: 60 } },
      { routeRulePageMtimes: { [other]: 0 } },
    ),
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.gaps).toHaveLength(1);
});

test.each([
  ["useRequestHeaders(['cookie'])", ""],
  [
    "const theme = useCookie('theme'); const dark = theme.value === 'dark'",
    "<div>{{ dark }}</div>",
  ],
  ["import * as nuxt from '#app'; nuxt.useRequestHeader('cookie')", ""],
  ["import * as h3 from 'h3'; h3.getCookie(useRequestEvent(), 'theme')", ""],
  ["useRequestEvent().context.tenant", ""],
])("reports an uncovered request dependency: %s", async (script, template) => {
  const file = "app/pages/account.vue";
  const result = await run({
    [file]: page(script, template),
    ".nuxt/doctor.manifest.json": manifest([{ path: "/account", file }], {
      "/account": { cache: { varies: ["accept-language"] } },
    }),
  });
  expect(result.diagnostics).toHaveLength(1);
});

test.each([
  ["nuxt.useRequestHeader('cookie')", 1],
  ["const nuxt = { useRequestHeader: (name: string) => name }; nuxt.useRequestHeader('cookie')", 0],
])("resolves namespace reads in the correct SFC scope: %s", async (script, count) => {
  const file = "app/pages/account.vue";
  const result = await run({
    [file]: `<script lang="ts">import * as nuxt from '#app'</script>\n${page(script)}`,
    ".nuxt/doctor.manifest.json": manifest([{ path: "/account", file }], {
      "/account": { swr: 60 },
    }),
  });
  expect(result.diagnostics).toHaveLength(count);
});

async function handler(files: Record<string, string>) {
  const result = await runRuleFixture({
    rule: noPersonalizedCachedHandler,
    framework: "nuxt",
    files,
  });
  return {
    diagnostics: result.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      line: diagnostic.range?.line,
      why: diagnostic.why,
      evidence: diagnostic.evidence,
    })),
    gaps: (result.project.evidenceGaps ?? []).filter(
      (gap) => gap.source === "vite-doctor/nuxt-route-rules",
    ),
  };
}

function serverManifest(route: string, file: string, routeRules: object, evidence = {}) {
  return JSON.stringify({
    generatedAt: "2100-01-01T00:00:00.000Z",
    appDir: "app",
    resolvedServerHandlers: [{ route, file, method: "get" }],
    routeRules,
    resolvedRouteRules: routeRules,
    routeRulePageMtimes: {},
    ...evidence,
  });
}

test.each([
  [
    "import * as h3 from 'h3'; export default cachedEventHandler(event => h3.getCookie(event, 'theme'))",
    1,
  ],
  [
    "import * as h3 from 'elsewhere'; export default cachedEventHandler(event => h3.getCookie(event, 'theme'))",
    0,
  ],
  [
    "import * as h3 from 'h3'; export default cachedEventHandler((event, h3) => h3.getCookie(event, 'theme'))",
    0,
  ],
  ["export default cachedEventHandler(event => event.node.req.url)", 0],
  ["export default cachedEventHandler(event => event.node.req.headers.cookie)", 1],
])("recognizes only proven handler request reads: %s", async (source, count) => {
  expect((await handler({ "server/api/theme.get.ts": source })).diagnostics).toHaveLength(count);
});

test.each(["getCookie(event, 'theme')", "event.context.tenant"])(
  "does not exempt %s when the route only varies on language",
  async (read) => {
    const file = "server/api/theme.get.ts";
    const result = await handler({
      [file]: `export default defineEventHandler(event => ${read})`,
      ".nuxt/doctor.manifest.json": serverManifest("/api/theme", file, {
        "/api/theme": { cache: { varies: ["accept-language"] } },
      }),
    });
    expect(result.diagnostics).toHaveLength(1);
  },
);

test("a custom handler cache key does not preserve a cookie header", async () => {
  const result = await handler({
    "server/api/theme.get.ts":
      "export default cachedEventHandler(event => getCookie(event, 'theme'), { getKey: () => 'theme' })",
  });
  expect(result.diagnostics).toHaveLength(1);
});

test("new page inputs invalidate handler coverage even when no rules were recorded", async () => {
  const file = "server/api/theme.get.ts";
  const result = await handler({
    [file]: "export default defineEventHandler(event => getCookie(event, 'theme'))",
    "app/pages/new.vue": page("defineRouteRules({ swr: 60 })"),
    ".nuxt/doctor.manifest.json": serverManifest(
      "/api/theme",
      file,
      {},
      {
        routeRulePageInventory: { "app/pages": [] },
      },
    ),
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.gaps[0]?.message).toContain("Nuxt page inputs changed");
});

test("NUXT0062 reports a cachedEventHandler that reads cookies through parseCookies", async () => {
  const result = await handler({
    "server/api/theme.get.ts":
      "export default cachedEventHandler(event => ({ theme: parseCookies(event).theme }))",
  });

  expect(result.diagnostics).toMatchObject([{ code: "NUXT0062" }]);
  expect(result.diagnostics[0]?.why).toContain("parseCookies()");
});

test("NUXT0062 stays quiet when a cached handler only names users", async () => {
  const result = await handler({
    "server/api/users.get.ts":
      "export default cachedEventHandler(async () => { const users = await listPublicUsers(); return users })",
  });

  expect(result.diagnostics).toEqual([]);
});

test.each([
  ["a swr wildcard", "/api/me", "server/api/me.get.ts", { "/api/**": { swr: 60 } }],
  [
    "a cache rule on a dynamic route",
    "/api/users/:id",
    "server/api/users/[id].get.ts",
    { "/api/users/**": { cache: { maxAge: 60 } } },
  ],
])(
  "NUXT0062 reports a handler that Nitro caches through %s",
  async (_name, route, file, routeRules) => {
    const result = await handler({
      [file]:
        "export default defineEventHandler(async event => {\n  return await getUserSession(event)\n})",
      ".nuxt/doctor.manifest.json": serverManifest(route, file, routeRules),
    });

    expect(result.diagnostics).toMatchObject([{ code: "NUXT0062", line: 1 }]);
    expect(result.diagnostics[0]?.why).toContain(route);
    expect(result.diagnostics[0]?.evidence?.[0]).toMatchObject({ kind: "manifest" });
  },
);

test.each([
  [
    "a more specific rule turns the cache off",
    { "/api/**": { swr: 60 }, "/api/me": { cache: false } },
  ],
  ["the cache varies on the cookie", { "/api/**": { cache: { maxAge: 60, varies: ["cookie"] } } }],
  ["no rule caches the route", { "/api/public/**": { swr: 60 } }],
])("NUXT0062 stays quiet for a route-rule handler when %s", async (_name, routeRules) => {
  const result = await handler({
    "server/api/me.get.ts": "export default defineEventHandler(event => getCookie(event, 'theme'))",
    ".nuxt/doctor.manifest.json": serverManifest("/api/me", "server/api/me.get.ts", routeRules),
  });

  expect(result.diagnostics).toEqual([]);
});

test("NUXT0062 records an evidence gap when a handler's route rules cannot be resolved", async () => {
  const result = await handler({
    "nuxt.config.ts": "export default defineNuxtConfig({ routeRules: { '/api/**': { swr: 60 } } })",
    "server/api/me.get.ts": "export default defineEventHandler(event => getUserSession(event))",
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.gaps).toHaveLength(1);
});
