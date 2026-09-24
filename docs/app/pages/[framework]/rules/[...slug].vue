<script setup lang="ts">
import { FRAMEWORK_META, parseFramework } from "../../../utils/rule-metadata";

definePageMeta({
  layout: "docs",
  validate: (route) => parseFramework(route.params.framework) !== null,
});

const route = useRoute();
const path = computed(() => route.path);
const framework = computed(() => {
  const value = parseFramework(route.params.framework);
  if (!value) throw createError({ statusCode: 404, statusMessage: "Unknown framework" });
  return value;
});
const meta = computed(() => FRAMEWORK_META[framework.value]);

const { data: rule } = await useRuleContent(path);

if (!rule.value) {
  throw createError({ statusCode: 404, statusMessage: "Rule not found" });
}

useHead(() => ({
  title: `${rule.value?.title || "Rule"} - ${meta.value.label} Doctor`,
  meta: [
    {
      name: "description",
      content: rule.value?.description || `${meta.value.label} Doctor rule reference.`,
    },
  ],
}));
</script>

<template>
  <UPage v-if="rule">
    <UPageHeader
      :title="rule.title"
      :description="rule.description"
      :headline="meta.label"
      :ui="{ wrapper: 'flex-row items-center flex-wrap justify-between' }"
    >
      <template #links>
        <UButton
          :to="`/${framework}/rules`"
          color="neutral"
          variant="outline"
          icon="i-lucide-arrow-left"
        >
          {{ meta.label }} rules
        </UButton>
      </template>
    </UPageHeader>

    <UPageBody>
      <RuleContent :rule="rule" />
    </UPageBody>

    <template #right>
      <DocsAsideRight :page="rule" />
    </template>
  </UPage>
</template>
