<script setup lang="ts">
import { categoryLabel, FRAMEWORK_META, type Framework } from "../../utils/rule-metadata";

definePageMeta({ layout: "docs" });

const route = useRoute();
const code = computed(() => String(route.params.code));

const { data: diagnostic } = await useAsyncData(
  () => `diagnostic-content-${code.value}`,
  () => queryCollection("diagnostics").where("code", "=", code.value).first(),
  { watch: [code] },
);

if (!diagnostic.value) {
  throw createError({ statusCode: 404, statusMessage: "Diagnostic not found" });
}

const meta = computed(() => FRAMEWORK_META[diagnostic.value?.framework as Framework]);
const ruleTitle = computed(() => diagnostic.value?.title.replace(/^[A-Z]+\d+:\s*/, "") ?? "");
const headline = computed(() =>
  [meta.value?.label, categoryLabel(diagnostic.value?.category ?? "")].filter(Boolean).join(" · "),
);
const tocPage = computed(() => diagnostic.value as any);

useHead(() => ({
  title: diagnostic.value?.title || code.value,
  meta: [
    {
      name: "description",
      content: diagnostic.value?.description || "Doctor diagnostic reference.",
    },
  ],
}));
</script>

<template>
  <UPage v-if="diagnostic">
    <UPageHeader
      :headline="headline"
      :description="diagnostic.description"
      :ui="{ wrapper: 'flex-row items-center flex-wrap justify-between' }"
    >
      <template #title>
        <span class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <code
            class="rounded-md bg-primary/10 px-2 py-0.5 font-mono text-[0.7em] font-semibold text-primary"
          >
            {{ diagnostic.code }}
          </code>
          <span>{{ ruleTitle }}</span>
        </span>
      </template>
      <template #links>
        <UButton
          v-if="diagnostic.rulePath"
          :to="diagnostic.rulePath"
          color="neutral"
          variant="outline"
          icon="i-lucide-book-open"
        >
          Rule page
        </UButton>
        <UButton
          :to="`/${diagnostic.framework}/rules`"
          color="neutral"
          variant="outline"
          icon="i-lucide-list-checks"
        >
          {{ meta?.label }} rules
        </UButton>
      </template>
    </UPageHeader>

    <UPageBody>
      <RuleContent :rule="diagnostic" />
    </UPageBody>

    <template #right>
      <DocsAsideRight :page="tocPage" />
    </template>
  </UPage>
</template>
