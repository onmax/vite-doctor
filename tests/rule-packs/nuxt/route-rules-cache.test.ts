import { describe, expect, test } from "vite-plus/test";
import {
  createProjectFixture,
  runProjectFixture,
  runRuleFixture,
} from "../../../src/core/testkit.ts";
import { runViteDoctor } from "../../../src/doctor.ts";
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
        confidence: diagnostic.confidence,
        evidence: diagnostic.evidence,
      })),
    gaps: (result.project.evidenceGaps ?? []).filter(
      (gap) => gap.source === "vite-doctor/nuxt-route-rules",
    ),
    cookieFlowGaps: (result.project.evidenceGaps ?? []).filter(
      (gap) => gap.source === `${RULE_ID}/cookie-flow`,
    ),
  };
}

const page = (script: string, template = "<div />") =>
  `<script setup lang="ts">\n${script}\n</script>\n<template>${template}</template>\n`;

const uncertainCookiePage = page(
  `const preferences = { theme: useCookie('theme').value }
function resetTheme() { preferences.theme = 'light' }
if (shouldReset()) resetTheme()
const rendered = preferences.theme`,
  "<div>{{ rendered }}</div>",
);

test.each([false, true])(
  "keeps both cookie-flow gaps on warm runs (seeded inventory: %s)",
  async (seeded) => {
    const files = ["app/pages/account.vue", "app/pages/profile.vue"];
    const fixture = createProjectFixture({
      framework: "nuxt",
      files: {
        [files[0]!]: uncertainCookiePage,
        [files[1]!]: uncertainCookiePage,
        ".nuxt/doctor.manifest.json": manifest(
          [
            { path: "/account", file: files[0]! },
            { path: "/profile", file: files[1]! },
          ],
          { "/**": { swr: 60 } },
        ),
      },
    });
    try {
      const { project: inventory } = await fixture.run({ run: { cache: false } });
      const existing = { source: "fixture", files: ["package.json"], message: "Existing gap" };
      const project = { ...inventory, evidenceGaps: seeded ? [existing] : undefined };
      const options = { project, rules: RULE_ID, cache: true };
      const cold = await runViteDoctor(options);
      const warm = await runViteDoctor(options);

      expect(project.evidenceGaps).toEqual(seeded ? [existing] : undefined);
      for (const result of [cold, warm]) {
        expect(
          result.project.evidenceGaps
            ?.filter((gap) => gap.source === `${RULE_ID}/cookie-flow`)
            .flatMap((gap) => gap.files)
            .sort(),
        ).toEqual(files);
      }
    } finally {
      await fixture.dispose();
    }
  },
);

test("unproven ISR coverage accounts for uncertain cookie flow", async () => {
  const file = "app/pages/account.vue";
  const result = await run({
    [file]: uncertainCookiePage,
    ".nuxt/doctor.manifest.json": manifest([{ path: "/account", file }], {
      "/account": { isr: 60 },
    }),
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.gaps[0]?.message).toContain("ISR coverage");
});

test.each([
  ["if (cookie.value === 'dark') label.title = 'Dark'", 1],
  ["cookie.value === 'dark' && (label.title = 'Dark')", 1],
  ["if (cookie.value === 'dark') setDark()", 1],
  ["function update() { if (cookie.value === 'dark') setDark() }; update()", 1],
  ["label[cookie.value === 'dark' ? 'title' : 'unused'] = 'Dark'", 1],
  ["if (cookie.value === 'dark') label.unused = 'Dark'", 0],
  ["if (cookie.value === 'dark') setDark(); label.title = 'Final'", 0],
])("tracks cookie-dependent write selection: %s", async (writes, gaps) => {
  const file = "app/pages/account.vue";
  const result = await run({
    [file]: page(
      `const cookie = useCookie('theme')
const label = { title: 'Hello' }
function setDark() { label.title = 'Dark' }
${writes}
const rendered = label.title`,
      "<div>{{ rendered }}</div>",
    ),
    ".nuxt/doctor.manifest.json": manifest([{ path: "/account", file }], {
      "/account": { swr: 60 },
    }),
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.cookieFlowGaps).toHaveLength(gaps);
});

test("bounds overlapping reads of a conditionally updated property", async () => {
  const file = "app/pages/account.vue";
  const updates = Array.from(
    { length: 250 },
    (_, index) =>
      `if (enabled.has(${index})) label.title = label.title.replaceAll(String(${index}), '')`,
  ).join("\n");
  const result = await run({
    [file]: page(
      `const cookie = useCookie('theme')
const label = { title: 'Hello' }
const enabled = new Set(useRuntimeConfig().public.enabledTransforms)
${updates}
const rendered = label.title`,
      "<div>{{ rendered }}</div>",
    ),
    ".nuxt/doctor.manifest.json": manifest([{ path: "/account", file }], {
      "/account": { swr: 60 },
    }),
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.cookieFlowGaps).toHaveLength(1);
});

test.each([
  ["title", "'Hello'", "'Welcome'", "", 0],
  ["title", "cookie.value", "'Welcome'", "", 1],
  ["title", "'Hello'", "cookie.value", "", 1],
  ["title", "'Hello'", "cookie.value", "label.title = 'Final'", 0],
  ["title.text", "{ text: 'Hello', sibling: cookie.value }", "{ text: 'Welcome' }", "", 0],
  ["title.text", "{ text: 'Hello' }", "{ text: cookie.value }", "", 1],
])(
  "ties uncertainty in %s (%s overwritten by %s; final write: %s) to its cookie source",
  async (selected, initial, written, finalWrite, gaps) => {
    const file = "app/pages/account.vue";
    const result = await run({
      [file]: page(
        `const cookie = useCookie('theme')
const label = { title: ${initial}, unused: cookie.value }
function updateLabel() { label.title = ${written} }
if (shouldUpdate()) updateLabel()
${finalWrite}
const rendered = label.${selected}`,
        "<div>{{ rendered }}</div>",
      ),
      ".nuxt/doctor.manifest.json": manifest([{ path: "/account", file }], {
        "/account": { swr: 60 },
      }),
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.cookieFlowGaps).toHaveLength(gaps);
  },
);

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
  expect(result.diagnostics[0]).toMatchObject({
    file,
    line: script.split("\n").length + 1,
    confidence: script.includes(".context.") ? "heuristic-medium" : "manifest-backed",
  });
  expect(result.diagnostics[0]?.why).toContain(kind);
  expect(result.diagnostics[0]?.evidence?.[0]).toMatchObject({ kind: "manifest" });
});

// Nitro's cached handler keeps `event.context` (nitropack/dist/runtime/internal/cache.mjs:255), but
// adapters and Nitro also store per-deployment values there, such as `context.cloudflare.env`.
test("reports an event.context read at heuristic confidence", async () => {
  const file = "app/pages/account.vue";
  const result = await run({
    [file]: page("const apiUrl = useRequestEvent()?.context.cloudflare.env.API_URL"),
    ".nuxt/doctor.manifest.json": manifest([{ path: "/account", file }], {
      "/account": { swr: 60 },
    }),
  });

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({ confidence: "heuristic-medium" });
  expect(result.diagnostics[0]?.why).toContain("if this field holds per-visitor data");
  expect(result.diagnostics[0]?.evidence?.[1]?.summary).toContain("per visitor");
});

test("reports a rendered context value separately from a stripped header", async () => {
  const file = "app/pages/account.vue";
  const script =
    "const user = useRequestEvent()?.context.user\nconsole.debug(useRequestHeader('x-request-id'))";
  const result = await run({
    [file]: page(script, "<div>{{ user }}</div>"),
    ".nuxt/doctor.manifest.json": manifest([{ path: "/account", file }], {
      "/account": { swr: 60 },
    }),
  });

  expect(result.diagnostics).toMatchObject([
    { line: 2, confidence: "heuristic-medium" },
    { line: 3, confidence: "manifest-backed" },
  ]);
  expect(result.diagnostics[0]?.why).toContain("if this field holds per-visitor data");
});

describe.each(["alias.theme = 'light'", "Object.assign(alias, { theme: 'light' })"])(
  "helper writing through a captured alias: %s",
  (write) => {
    test.each([
      ["called before the read", "resetTheme()", "", 0],
      ["called after the read", "", "resetTheme()", 1],
      ["never called", "", "", 1],
      ["called only on the client", "if (import.meta.client) resetTheme()", "", 1],
    ])("traces a rendered cookie when the helper is %s", async (_, before, after, count) => {
      const file = "app/pages/account.vue";
      const result = await run({
        [file]: page(
          `const preferences = { theme: useCookie('theme').value }
function resetTheme() { ${write} }
const alias = preferences
${before}
const rendered = preferences.theme
${after}`,
          "<div>{{ rendered }}</div>",
        ),
        ".nuxt/doctor.manifest.json": manifest([{ path: "/account", file }], {
          "/account": { swr: 60 },
        }),
      });
      expect(result.diagnostics).toHaveLength(count);
    });
  },
);

test.each([
  ["hoisted declaration", "", "function resetTheme() { preferences.theme = 'light' }"],
  [
    "nested call through a const alias",
    "const overwrite = () => { preferences.theme = 'light' }; const alias = overwrite; const resetTheme = () => alias()",
    "",
  ],
])("accounts for a pre-read helper write through a %s", async (_, before, after) => {
  const file = "app/pages/account.vue";
  const result = await run({
    [file]: page(
      `const preferences = { theme: useCookie('theme').value }
${before}
resetTheme()
const rendered = preferences.theme
${after}`,
      "<div>{{ rendered }}</div>",
    ),
    ".nuxt/doctor.manifest.json": manifest([{ path: "/account", file }], {
      "/account": { swr: 60 },
    }),
  });
  expect(result.diagnostics).toHaveLength(0);
});

test.each([
  [
    "a promise continuation",
    "void Promise.resolve().then(resetTheme)",
    "function",
    "preferences.theme = 'light'",
    1,
  ],
  [
    "an uninvoked function argument",
    "Object.freeze(resetTheme)",
    "function",
    "preferences.theme = 'light'",
    1,
  ],
  [
    "a local wrapper that schedules its argument",
    "const schedule = (fn: () => void) => Promise.resolve().then(fn); void schedule(resetTheme)",
    "function",
    "preferences.theme = 'light'",
    1,
  ],
  [
    "a local wrapper that calls its argument",
    "const invoke = (fn: () => void) => fn(); invoke(resetTheme)",
    "function",
    "preferences.theme = 'light'",
    0,
  ],
  [
    "an unawaited async write",
    "void resetTheme()",
    "async function",
    "await 0; preferences.theme = 'light'",
    1,
  ],
  [
    "an awaited async write",
    "await resetTheme()",
    "async function",
    "await 0; preferences.theme = 'light'",
    0,
  ],
  [
    "an awaited synchronous wrapper",
    "const reset = () => resetTheme(); await reset()",
    "async function",
    "await 0; preferences.theme = 'light'",
    0,
  ],
  [
    "an awaited async wrapper",
    "const reset = async () => resetTheme(); await reset()",
    "async function",
    "await 0; preferences.theme = 'light'",
    0,
  ],
  [
    "an awaited forwarded promise",
    "const invoke = (fn: () => Promise<void>) => fn(); await invoke(resetTheme)",
    "async function",
    "await 0; preferences.theme = 'light'",
    0,
  ],
  [
    "an unreachable suspension",
    "void resetTheme()",
    "async function",
    "if (false) await 0; preferences.theme = 'light'",
    0,
  ],
  [
    "a suspension in setup after an unawaited call",
    "void resetTheme(); await 0",
    "async function",
    "await 0; preferences.theme = 'light'",
    0,
  ],
  [
    "a skipped setup suspension",
    "void resetTheme(); if (false) await 0",
    "async function",
    "await 0; preferences.theme = 'light'",
    1,
  ],
  [
    "a setup suspension before the call starts",
    "await 0; void resetTheme()",
    "async function",
    "await 0; preferences.theme = 'light'",
    1,
  ],
  [
    "an unjoined promise continuation with a setup suspension",
    "void Promise.resolve().then(resetTheme); await unrelatedWork()",
    "function",
    "preferences.theme = 'light'",
    0,
  ],
  [
    "a write in the synchronous prefix",
    "void resetTheme()",
    "async function",
    "preferences.theme = 'light'; await 0",
    0,
  ],
  [
    "a write in the await operand",
    "void resetTheme()",
    "async function",
    "await (preferences.theme = 'light')",
    0,
  ],
  [
    "an awaited assignment value",
    "void resetTheme()",
    "async function",
    "preferences.theme = await 'light'",
    1,
  ],
  [
    "an unawaited outer helper",
    "void resetTheme()",
    "async function",
    "await overwrite(); async function overwrite() { await 0; preferences.theme = 'light' }",
    1,
  ],
  [
    "an awaited outer helper",
    "await resetTheme()",
    "async function",
    "await overwrite(); async function overwrite() { await 0; preferences.theme = 'light' }",
    0,
  ],
  ["an unconsumed generator", "resetTheme()", "function*", "preferences.theme = 'light'", 1],
])("orders a helper write for %s", async (_, invocation, declaration, body, count) => {
  const file = "app/pages/account.vue";
  const result = await run({
    [file]: page(
      `const preferences = { theme: useCookie('theme').value }
${invocation}
const rendered = preferences.theme
${declaration} resetTheme() { ${body} }`,
      "<div>{{ rendered }}</div>",
    ),
    ".nuxt/doctor.manifest.json": manifest([{ path: "/account", file }], {
      "/account": { swr: 60 },
    }),
  });
  expect(result.diagnostics).toHaveLength(count);
  expect(result.cookieFlowGaps).toHaveLength(count === 0 ? 1 : 0);
});

test.each(["const alias = alias", "const alias = other; const other = alias"])(
  "traces rendered cookies past an uncalled helper with a cyclic alias: %s",
  async (declaration) => {
    const file = "app/pages/account.vue";
    const result = await run({
      [file]: page(
        `const preferences = { theme: useCookie('theme').value }
function unused() { ${declaration}; Object.assign(alias, {}) }
const rendered = preferences.theme`,
        "<div>{{ rendered }}</div>",
      ),
      ".nuxt/doctor.manifest.json": manifest([{ path: "/account", file }], {
        "/account": { swr: 60 },
      }),
    });
    expect(result.diagnostics).toMatchObject([{ line: 2 }]);
  },
);

test.each([
  ["layout", 0],
  ["theme", 1],
])(
  "traces a rendered local to the selected cookie-bearing property: %s",
  async (property, count) => {
    const file = "app/pages/account.vue";
    const result = await run({
      [file]: page(
        `const preferences = { theme: useCookie('theme'), layout: 'grid' }; const rendered = preferences.${property}`,
        "<div>{{ rendered }}</div>",
      ),
      ".nuxt/doctor.manifest.json": manifest([{ path: "/account", file }], {
        "/account": { swr: 60 },
      }),
    });
    expect(result.diagnostics).toHaveLength(count);
  },
);

test.each([
  [
    "an assignment from a sibling cookie",
    "preferences.theme = preferences.cookie.value ?? 'light'; const rendered = preferences.theme",
    1,
  ],
  [
    "an assignment from a separate binding",
    "const theme = useCookie('theme'); preferences.theme = theme.value ?? 'light'; const rendered = preferences.theme",
    1,
  ],
  [
    "an assignment to an unused sibling",
    "preferences.cookie = useCookie('other'); const rendered = preferences.theme",
    0,
  ],
  [
    "an assignment after the selected read",
    "const rendered = preferences.theme; preferences.theme = preferences.cookie.value ?? 'light'",
    0,
  ],
  [
    "an assignment through a const alias",
    "const alias = preferences; alias['theme'] = preferences.cookie.value; const rendered = preferences.theme",
    1,
  ],
  [
    "an assignment overwritten before rendering",
    "preferences.theme = preferences.cookie.value; preferences.theme = 'light'; const rendered = preferences.theme",
    0,
  ],
  [
    "an overwrite in the SSR branch",
    "preferences.theme = preferences.cookie.value; if (import.meta.server) preferences.theme = 'light'; const rendered = preferences.theme",
    0,
  ],
  [
    "an overwrite in the client branch",
    "preferences.theme = preferences.cookie.value; if (import.meta.client) preferences.theme = 'light'; const rendered = preferences.theme",
    1,
  ],
  [
    "a read in the client branch of a ternary",
    "preferences.theme = preferences.cookie.value; if (import.meta.client) preferences.theme = 'light'; const rendered = import.meta.client ? preferences.theme : 'light'",
    0,
  ],
  [
    "a read short-circuited on the server",
    "preferences.theme = preferences.cookie.value; if (import.meta.client) preferences.theme = 'light'; const rendered = import.meta.client && preferences.theme",
    0,
  ],
  [
    "a read in the server branch of a ternary",
    "preferences.theme = preferences.cookie.value; if (import.meta.client) preferences.theme = 'light'; const rendered = import.meta.client ? 'light' : preferences.theme",
    1,
  ],
  [
    "an overwrite in onMounted",
    "preferences.theme = preferences.cookie.value; onMounted(() => { preferences.theme = 'light' }); const rendered = preferences.theme",
    1,
  ],
  [
    "a client-only mutation call",
    "preferences.theme = preferences.cookie.value; import.meta.client && Object.assign(preferences, { theme: 'light' }); const rendered = preferences.theme",
    1,
  ],
  [
    "an overwrite guarded by client or a runtime condition",
    "preferences.theme = preferences.cookie.value; if (import.meta.client || runtimeFlag()) preferences.theme = 'light'; const rendered = preferences.theme",
    0,
  ],
  [
    "an overwrite in a local function named onMounted",
    "const onMounted = (fn: () => void) => fn(); preferences.theme = preferences.cookie.value; onMounted(() => { preferences.theme = 'light' }); const rendered = preferences.theme",
    0,
  ],
  [
    "a mutation call through an alias",
    "preferences.theme = preferences.cookie.value; const alias = preferences; Object.assign(alias, { theme: 'light' }); const rendered = preferences.theme",
    0,
  ],
  [
    "a computed overwrite with an unknown key",
    "preferences.theme = preferences.cookie.value; preferences[String('theme')] = 'light'; const rendered = preferences.theme",
    0,
  ],
  [
    "an overwrite of the initializer",
    "if (import.meta.server) preferences.cookie = null; const rendered = preferences.cookie?.value",
    0,
  ],
  [
    "a conditional write to an unused sibling",
    "preferences.theme = preferences.cookie.value; if (import.meta.server) preferences.cookie = null; const rendered = preferences.theme",
    1,
  ],
  [
    "a definite write after a mutation call",
    "const theme = useCookie('theme'); Object.assign(preferences, { theme: 'light' }); preferences.theme = theme.value; const rendered = preferences.theme",
    1,
  ],
  [
    "a deletion before the selected read",
    "preferences.theme = preferences.cookie.value; delete preferences.theme; const rendered = preferences.theme",
    0,
  ],
  [
    "a mutation call after the selected read",
    "preferences.theme = preferences.cookie.value; const rendered = preferences.theme; Object.assign(preferences, { theme: 'light' })",
    1,
  ],
])("traces a rendered object property through setup writes: %s", async (_, setup, count) => {
  const file = "app/pages/account.vue";
  const result = await run({
    [file]: page(
      `const preferences = { theme: 'light', cookie: useCookie<string>('theme') }; ${setup}`,
      "<div>{{ rendered }}</div>",
    ),
    ".nuxt/doctor.manifest.json": manifest([{ path: "/account", file }], {
      "/account": { swr: 60 },
    }),
  });
  expect(result.diagnostics).toHaveLength(count);
});

test("reports a read in a function not proven to run during server render at heuristic confidence", async () => {
  const file = "app/pages/search.vue";
  // The callback runs only when the button is clicked, but Doctor can't see inside useSearchBox.
  const script = [
    "import { useSearchBox } from '~/composables/search-box'",
    "const { submit } = useSearchBox(() => useRequestURL().searchParams.get('q'))",
  ].join("\n");
  const result = await run({
    [file]: page(script, '<button @click="submit">Search</button>'),
    ".nuxt/doctor.manifest.json": manifest([{ path: "/search", file }], {
      "/search": { prerender: true },
    }),
  });

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({ line: 3, confidence: "heuristic-medium" });
  expect(result.diagnostics[0]?.why).toContain("in code that may run while the page renders");
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

test.each([
  ["varies: [...['cookie']]", 0],
  ["varies: [...['accept-language']]", 1],
  ["varies: ['cookie'], getKey: () => ''", 0],
  ["varies: ['cookie'], async getKey() { return '' }", 0],
  ["varies: ['cookie'], getKey: () => 'shared'", 1],
  ["varies: ['accept-language'], getKey: () => ''", 1],
])("accounts for effective handler variation with %s", async (options, count) => {
  const result = await handler({
    "server/api/theme.get.ts": `export default cachedEventHandler(event => getCookie(event, 'theme'), { ${options} })`,
  });
  expect(result.diagnostics).toHaveLength(count);
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
