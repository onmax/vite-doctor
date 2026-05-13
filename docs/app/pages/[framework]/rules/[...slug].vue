<script setup lang="ts">
import { FRAMEWORK_META, type Framework } from "../../../utils/rule-metadata";

definePageMeta({
  validate: (route) => ["vue", "vite", "nuxt", "nitro"].includes(String(route.params.framework)),
});

const route = useRoute();
const path = computed(() => route.path);
const framework = computed(() => String(route.params.framework) as Framework);
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
  <main class="mx-auto max-w-4xl px-6 py-10 sm:px-10">
    <div class="mb-8">
      <UButton
        :to="`/rules/${framework}`"
        color="neutral"
        variant="link"
        icon="i-lucide-arrow-left"
        class="px-0"
      >
        {{ meta.label }} rules
      </UButton>
      <h1 class="mt-3 text-3xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
        {{ rule?.title }}
      </h1>
      <p class="mt-3 text-base text-neutral-600 dark:text-neutral-400">
        {{ rule?.description }}
      </p>
    </div>

    <RuleContent :rule="rule" />
  </main>
</template>
