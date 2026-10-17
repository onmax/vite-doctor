import { expect, test } from "vite-plus/test";
import { runNuxtAppRuleFixture } from "../../rule-fixtures.ts";
import { noRawFetchInSetup } from "../../../src/rule-packs/nuxt/rules/nuxt/no-raw-fetch-in-setup.ts";

const rule = "nuxt/fetch/no-raw-fetch-in-setup";

test.each([
  ["script setup", `<script setup lang="ts">\nconst user = await $fetch('/api/user')\n</script>`],
  [
    "script setup write",
    `<script setup lang="ts">\nawait $fetch('/api/visit', { method: 'POST' })\n</script>`,
  ],
  [
    "setup() method",
    `<script lang="ts">\nexport default defineNuxtComponent({\n  async setup() {\n    const user = await $fetch('/api/user')\n    return { user }\n  },\n})\n</script>`,
  ],
  [
    "setup property",
    `<script lang="ts">\nexport default defineComponent({\n  setup: async () => {\n    const user = await fetch('/api/user')\n    return { user }\n  },\n})\n</script>`,
  ],
  [
    "setup block inside if",
    `<script setup lang="ts">\nif (true) {\n  const user = await $fetch('/api/user')\n}\n</script>`,
  ],
])("reports raw fetches awaited directly in setup: %s", async (_, source) => {
  const result = await runNuxtAppRuleFixture(noRawFetchInSetup, source);
  expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([rule]);
});

test.each([
  ["normal script top level", `<script lang="ts">const user = await $fetch('/api/user')</script>`],
  [
    "named handler",
    `<script setup lang="ts">\nasync function save() {\n  await $fetch('/api/user', { method: 'PATCH' })\n}\n</script>\n<template><button type="button" @click="save">Save</button></template>`,
  ],
  [
    "arrow handler",
    `<script setup lang="ts">\nconst remove = async () => {\n  await $fetch('/api/user', { method: 'DELETE' })\n}\n</script>`,
  ],
  [
    "grid datasource callback",
    `<script setup lang="ts">\nconst datasource = {\n  getRows: async (params) => {\n    params.success(await $fetch('/api/rows'))\n  },\n}\n</script>`,
  ],
  [
    "async data handler",
    `<script setup lang="ts">\nconst { data } = await useAsyncData('user', async () => await $fetch('/api/user'))\n</script>`,
  ],
  [
    "object method",
    `<script setup lang="ts">\nconst actions = {\n  async refresh() {\n    await $fetch('/api/user')\n  },\n}\n</script>`,
  ],
  [
    "method beside setup()",
    `<script lang="ts">\nexport default defineComponent({\n  methods: {\n    async save() {\n      await $fetch('/api/user', { method: 'POST' })\n    },\n  },\n})\n</script>`,
  ],
  [
    "nested function inside setup()",
    `<script lang="ts">\nexport default defineComponent({\n  setup() {\n    const save = async () => await $fetch('/api/user', { method: 'POST' })\n    return { save }\n  },\n})\n</script>`,
  ],
])("ignores raw fetches inside nested functions: %s", async (_, source) => {
  const result = await runNuxtAppRuleFixture(noRawFetchInSetup, source);
  expect(result.diagnostics).toEqual([]);
});
