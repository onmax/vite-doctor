<script setup lang="ts">
import { FRAMEWORK_META, type Framework } from "../../../utils/rule-metadata";

definePageMeta({
  layout: "docs",
  validate: (route) => ["vue", "vite", "nuxt", "nitro"].includes(String(route.params.framework)),
});

const route = useRoute();
const framework = computed(() => String(route.params.framework) as Framework);
const meta = computed(() => FRAMEWORK_META[framework.value]);

useHead(() => ({
  title: `${meta.value.label} rules - Vite Doctor`,
  meta: [
    {
      name: "description",
      content: `Browse ${meta.value.label} Doctor rules and installation guidance.`,
    },
  ],
}));
</script>

<template>
  <FrameworkRulesPage :framework="framework" />
</template>
