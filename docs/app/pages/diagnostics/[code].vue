<script setup lang="ts">
const route = useRoute();
const code = computed(() => String(route.params.code));
const path = computed(() => `/diagnostics/${code.value}`);

const { data: diagnostic } = await useAsyncData(
  () => `diagnostic-content-${path.value}`,
  () => queryCollection("diagnostics").where("code", "=", code.value).first(),
  { watch: [path] },
);

if (!diagnostic.value) {
  throw createError({ statusCode: 404, statusMessage: "Diagnostic not found" });
}

useHead(() => ({
  title: `${diagnostic.value?.code || "Diagnostic"} - Doctor`,
  meta: [
    {
      name: "description",
      content: diagnostic.value?.description || "Doctor diagnostic reference.",
    },
  ],
}));
</script>

<template>
  <main class="mx-auto max-w-4xl px-6 py-10 sm:px-10">
    <div class="mb-8">
      <UButton
        to="/vite/rules"
        color="neutral"
        variant="link"
        icon="i-lucide-arrow-left"
        class="px-0"
      >
        Rules
      </UButton>
      <h1 class="mt-3 text-3xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
        {{ diagnostic?.code }}
      </h1>
      <p class="mt-3 text-base text-neutral-600 dark:text-neutral-400">
        {{ diagnostic?.description }}
      </p>
    </div>

    <ContentRenderer v-if="diagnostic" :value="diagnostic" />
  </main>
</template>
