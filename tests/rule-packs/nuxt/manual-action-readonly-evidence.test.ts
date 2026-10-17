import { expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import { noManualActionUseFetch } from "../../../src/rule-packs/nuxt/rules/nuxt/no-manual-action-usefetch.ts";
import { postFetchRequiresReadonlyMarker } from "../../../src/rule-packs/nuxt/rules/nuxt/post-fetch-requires-readonly-marker.ts";

const ruleId = "nuxt/no-manual-action-usefetch";

async function diagnose(script: string, readonlyPaths?: string[]) {
  const result = await runProjectFixture({
    framework: "nuxt",
    rules: [noManualActionUseFetch],
    config: readonlyPaths ? { rules: { [ruleId]: ["warn", { readonlyPaths }] } } : undefined,
    files: { "app/pages/kpi.vue": `<script setup lang="ts">\n${script}\n</script>` },
  });
  return result.diagnostics.map((diagnostic) =>
    /This [A-Z]+ async-data entry/.test(diagnostic.message) ? "write" : "read",
  );
}

test("accepts an async-data entry marked read-only inline", async () => {
  expect(
    await diagnose(`const { refresh } = useAsyncData('sales', (_app, { signal }) => /* nuxt-doctor: async-data-readonly */ $fetch('/api/kpis/sales', {
  method: 'POST',
  body,
  signal,
}), { immediate: false })`),
  ).toEqual([]);
});

test("accepts an async-data entry whose request matches readonlyPaths", async () => {
  expect(
    await diagnose(
      `const { refresh } = useAsyncData('kpis', (_app, { signal }) => $fetch('/api/kpis', { method: 'POST', body, signal }), { immediate: false })`,
      ["/api/kpis"],
    ),
  ).toEqual([]);
});

test("accepts a fetch entry whose POST path is query-like", async () => {
  expect(
    await diagnose(
      `const { execute } = useLazyFetch('/api/npi/launches/query', { method: 'POST', immediate: false, server: false })`,
    ),
  ).toEqual([]);
});

test("accepts a write-like POST covered by readonlyPaths", async () => {
  expect(
    await diagnose(
      `const { execute } = useFetch('/api/reports/run', { method: 'POST', immediate: false })`,
      ["/api/reports/**"],
    ),
  ).toEqual([]);
});

test.each([
  [
    "a read without read-only evidence",
    `const { refresh } = useAsyncData('settings', () => $fetch('/api/settings'), { immediate: false })`,
    ["read"],
  ],
  [
    "a handler with one unproven request",
    `const { refresh } = useAsyncData('kpis', async () => {
  const kpis = await $fetch('/api/kpis', { method: 'POST' })
  const jobs = await $fetch('/api/jobs/trigger', { method: 'POST' })
  return { kpis, jobs }
}, { immediate: false })`,
    ["read"],
  ],
  [
    "a readonlyPaths miss",
    `const { refresh } = useAsyncData('orders', () => $fetch('/api/orders', { method: 'POST' }), { immediate: false })`,
    ["read"],
  ],
  [
    "a write-like POST",
    `const { execute } = useFetch('/api/jobs/trigger', { method: 'POST', immediate: false })`,
    ["write"],
  ],
  [
    "a DELETE marked read-only",
    `const { execute } = useFetch('/api/kpis', { method: 'DELETE', immediate: false, meta: { readonly: true } })`,
    ["write"],
  ],
])("still reports %s", async (_, script, severities) => {
  expect(await diagnose(script, ["/api/kpis"])).toEqual(severities);
});

test("write-like POST guidance names the rule option that holds readonlyPaths", async () => {
  const result = await runProjectFixture({
    framework: "nuxt",
    rules: [postFetchRequiresReadonlyMarker],
    files: {
      "app/pages/jobs.vue": `<script setup lang="ts">useFetch('/api/jobs/trigger', { method: 'POST', body })</script>`,
    },
  });
  const fix = result.diagnostics[0]?.suggestion ?? "";
  expect(fix).not.toContain("Nuxt Doctor module");
  expect(fix).toContain("nuxt/post-fetch-requires-readonly-marker");
  expect(fix).toContain("readonlyPaths");
  expect(fix).toContain("nuxt-doctor: async-data-readonly");
});
