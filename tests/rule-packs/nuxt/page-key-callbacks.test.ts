import { expect, test } from "vite-plus/test";
import { runNuxtAppRuleFixture } from "../../../src/core/testkit.ts";
import { noRouteObjectPageKey } from "../../../src/rule-packs/nuxt/rules/nuxt/no-route-object-page-key.ts";

test.each([
  'page-key="route"',
  ":page-key=\"'route'\"",
  ':page-key="keys.route"',
  ':page-key="route => route.fullPath"',
  ':page-key="route => route && route.fullPath"',
  ':page-key="route => { return route && route.fullPath }"',
  ':page-key="route => route.params.slug"',
  ':page-key="($route) => $route.path"',
  ':page-key="({ params }) => params.slug"',
  ':page-key="function (route) { return route.path }"',
  ':page-key="function key(route) { return route.path }"',
  ':page-key="route => { const key = route.path; return key }"',
  ":page-key=\"route => { { const route = 'fixed'; return route } }\"",
  ':page-key="route => { function helper() { return route }; return route.path }"',
  ':page-key="route => ({ route: route.path }).route"',
  ':page-key="key" :name="route.name"',
])("accepts a stable page key: %s", async (attributes) => {
  const result = await runNuxtAppRuleFixture(
    noRouteObjectPageKey,
    `<template><NuxtPage ${attributes} /></template>`,
    "app/app.vue",
  );
  expect(result.diagnostics).toEqual([]);
});

test.each([
  "$route",
  "$route.fullPath",
  "route",
  "route.fullPath",
  "route => $route.fullPath",
  "() => route.fullPath",
  "route => route",
  "route => route || route.fullPath",
  "route => route ?? route.fullPath",
  "route => route.fullPath && route",
  "route => route.fullPath || route",
  "route => route.fullPath ?? route",
  "current => current",
  "function key(route) { return route }",
  "route => { return route }",
  "route => { if (route.params.slug) return route; return 'fixed' }",
])("reports external route state or a returned route object: %s", async (expression) => {
  const result = await runNuxtAppRuleFixture(
    noRouteObjectPageKey,
    `<template><NuxtPage :page-key="${expression}" /></template>`,
    "app/app.vue",
  );
  expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
    noRouteObjectPageKey.meta.id,
  ]);
});
