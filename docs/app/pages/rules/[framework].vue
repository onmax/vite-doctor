<script setup lang="ts">
import { FRAMEWORK_META, parseFramework } from "../../utils/rule-metadata";

definePageMeta({
  layout: "docs",
  validate: (route) => parseFramework(route.params.framework) !== null,
});

const route = useRoute();
const framework = computed(() => {
  const value = parseFramework(route.params.framework);
  if (!value) throw createError({ statusCode: 404, statusMessage: "Unknown framework" });
  return value;
});
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
