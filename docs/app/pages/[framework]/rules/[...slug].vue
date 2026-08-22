<script setup lang="ts">
import { FRAMEWORK_META, FRAMEWORKS, type Framework } from "../../../utils/rule-metadata";

definePageMeta({
  layout: "docs",
  validate: (route) => FRAMEWORKS.includes(String(route.params.framework) as Framework),
});

const route = useRoute();
const path = computed(() => route.path);
const framework = computed(() => String(route.params.framework) as Framework);
const meta = computed(() => FRAMEWORK_META[framework.value]);
const tocPage = computed(() => rule.value as any);

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
      <DocsAsideRight :page="tocPage" />
    </template>
  </UPage>
</template>
