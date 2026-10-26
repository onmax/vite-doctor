import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { keepaliveRequiresMax } from "../../../src/rule-packs/nuxt/rules/nuxt/keepalive-requires-max.ts";

function page(meta: string) {
  return `<script setup lang="ts">
definePageMeta(${meta})
</script>

<template><div /></template>
`;
}

async function run(files: Record<string, string>) {
  return runRuleFixture({ framework: "nuxt", rule: keepaliveRequiresMax, files });
}

test("reports a dynamic page with keepalive: true and no max", async () => {
  const result = await run({
    "app/pages/product/[id].vue": page("{ keepalive: true }"),
  });

  expect(result.diagnostics).toHaveLength(1);
  const [diagnostic] = result.diagnostics;
  expect(diagnostic?.code).toBe("NUXT0094");
  expect(diagnostic?.severity).toBe("warn");
  expect(diagnostic?.confidence).toBe("heuristic-high");
  expect(diagnostic?.why).toContain(":id");
  expect(diagnostic?.suggestion).toContain("max");
  expect(diagnostic?.evidence?.map((item) => item.kind)).toEqual(["facts", "ast"]);
});

test.each([
  ["a dynamic parent directory", "app/pages/[org]/settings.vue", "{ keepalive: true }", ":org"],
  ["a catch-all segment", "app/pages/docs/[...slug].vue", "{ keepalive: true }", ":slug"],
  ["an optional segment", "app/pages/blog/[[page]].vue", "{ keepalive: true }", ":page"],
  [
    "a keepalive options object without max",
    "app/pages/product/[id].vue",
    "{ keepalive: { include: ['Product'] } }",
    ":id",
  ],
  [
    "a key that returns the full path",
    "app/pages/product/[id].vue",
    "{ keepalive: true, key: route => route.fullPath }",
    ":id",
  ],
  [
    "a key that interpolates a param",
    "app/pages/product/[id].vue",
    "{ keepalive: true, key: (route) => { return `product-${route.params.id}` } }",
    ":id",
  ],
  [
    "an unbounded param next to a locale",
    "app/pages/[locale]/product/[id].vue",
    "{ keepalive: true }",
    ":id",
  ],
])("reports %s", async (_name, file, meta, param) => {
  const result = await run({ [file]: page(meta) });

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.why).toContain(param);
  expect(result.diagnostics[0]?.why).not.toContain(":locale");
});

test.each([
  ["keepalive with max", "app/pages/product/[id].vue", "{ keepalive: { max: 5 } }"],
  ["a static page", "app/pages/about.vue", "{ keepalive: true }"],
  ["a static page in a nested directory", "app/pages/account/settings.vue", "{ keepalive: true }"],
  ["a static string key", "app/pages/product/[id].vue", "{ keepalive: true, key: 'product' }"],
  [
    "a key that ignores the route",
    "app/pages/product/[id].vue",
    "{ keepalive: true, key: () => 'product' }",
  ],
  [
    "a key that never reads its route argument",
    "app/pages/product/[id].vue",
    "{ keepalive: true, key: (route) => 'product' }",
  ],
  [
    "a key that reads only the route name",
    "app/pages/product/[id].vue",
    "{ keepalive: true, key: route => String(route.name) }",
  ],
  [
    "a key that keeps only the locale",
    "app/pages/[locale]/product/[id].vue",
    "{ keepalive: true, key: route => route.params.locale }",
  ],
  ["a locale param", "app/pages/[locale]/about.vue", "{ keepalive: true }"],
  ["a lang param", "app/pages/[lang].vue", "{ keepalive: true }"],
  ["an unanalyzable key", "app/pages/product/[id].vue", "{ keepalive: true, key: pageKey }"],
  [
    "a key computed through a helper",
    "app/pages/product/[id].vue",
    "{ keepalive: true, key: route => keyFor(route) }",
  ],
  ["keepalive false", "app/pages/product/[id].vue", "{ keepalive: false }"],
  ["keepalive from a variable", "app/pages/product/[id].vue", "{ keepalive: options }"],
  [
    "keepalive with exclude",
    "app/pages/product/[id].vue",
    "{ keepalive: { exclude: ['Product'] } }",
  ],
  ["a spread meta object", "app/pages/product/[id].vue", "{ ...shared, keepalive: true }"],
  [
    "a static route path override",
    "app/pages/product/[id].vue",
    "{ keepalive: true, path: '/product' }",
  ],
  ["a component outside pages", "app/components/[id].vue", "{ keepalive: true }"],
])("does not report %s", async (_name, file, meta) => {
  const result = await run({ [file]: page(meta) });

  expect(result.diagnostics).toEqual([]);
});

test("names only the params a key keeps", async () => {
  const result = await run({
    "app/pages/[org]/product/[id].vue": page("{ keepalive: true, key: route => route.params.id }"),
  });

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.why).toContain(":id");
  expect(result.diagnostics[0]?.why).not.toContain(":org");
});

test("reads params from a definePageMeta path override", async () => {
  const result = await run({
    "app/pages/product.vue": page("{ keepalive: true, path: '/product/:sku' }"),
  });

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.why).toContain(":sku");
});

test("prefers the resolved Nuxt pages from a current manifest", async () => {
  const manifest = (pages: Array<{ path: string; file: string }>) =>
    JSON.stringify({ generatedAt: "2100-01-01T00:00:00.000Z", appDir: "app", pages });
  const reported = await run({
    "app/pages/product.vue": page("{ keepalive: true }"),
    ".nuxt/doctor.manifest.json": manifest([
      { path: "/product/:sku()", file: "app/pages/product.vue" },
    ]),
  });
  const notAPage = await run({
    "app/pages/product/[id].vue": page("{ keepalive: true }"),
    ".nuxt/doctor.manifest.json": manifest([{ path: "/", file: "app/pages/index.vue" }]),
  });

  expect(reported.diagnostics).toHaveLength(1);
  expect(reported.diagnostics[0]?.why).toContain(":sku");
  expect(reported.diagnostics[0]?.evidence?.[0]).toMatchObject({ kind: "manifest" });
  expect(notAPage.diagnostics).toEqual([]);
});
