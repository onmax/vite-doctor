<script setup lang="ts">
import type { RawRuleEntry } from "../../utils/rule-catalog";
import { FRAMEWORK_META, type Framework } from "../../utils/rule-metadata";

definePageMeta({
  header: false,
  footer: false,
  layout: false,
  validate: (route) => ["vue", "vite", "nuxt", "nitro"].includes(String(route.params.framework)),
});

const route = useRoute();
const framework = computed(() => String(route.params.framework) as Framework);

const meta = computed(() => FRAMEWORK_META[framework.value]);
const { data: rules } = await useAsyncData(
  () => `rules-${framework.value}`,
  () => queryCollection("rules").all(),
  {
    watch: [framework],
    transform: (items) =>
      items.filter((rule) =>
        framework.value === "nuxt"
          ? ["vue", "nitro", "nuxt"].includes(rule.framework)
          : rule.framework === framework.value,
      ),
  },
);

useHead(() => ({
  title: `${meta.value.label} Doctor rules - every check, one page.`,
  meta: [
    {
      name: "description",
      content: `Browse every ${meta.value.label} Doctor rule by category, severity, and fixability.`,
    },
  ],
  link: [
    { rel: "preconnect", href: "https://fonts.googleapis.com" },
    { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" },
    {
      rel: "stylesheet",
      href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap",
    },
  ],
}));

const colorMode = useColorMode();
const isDark = computed(() => colorMode.value === "dark");
function toggleTheme() {
  colorMode.preference = isDark.value ? "light" : "dark";
}
</script>

<template>
  <div
    class="relative min-h-dvh w-full isolate overflow-hidden bg-white font-sans text-neutral-800 antialiased dark:bg-neutral-950 dark:text-neutral-200 selection:bg-primary-500/20 selection:text-primary-900 dark:selection:text-primary-50"
  >
    <main class="w-full px-4 pt-3 pb-10 sm:px-8 lg:px-10">
      <div class="flex justify-end gap-2">
        <button
          type="button"
          :aria-label="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
          class="relative inline-flex size-8 items-center justify-center rounded-md text-neutral-500 hover:bg-primary-400/5 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
          @click="toggleTheme"
        >
          <UIcon :name="isDark ? 'i-lucide-moon-star' : 'i-lucide-sun'" class="size-5" />
        </button>
        <a
          href="https://github.com/onmax/nuxt-doctor"
          target="_blank"
          rel="noopener"
          aria-label="Open GitHub repository"
          class="relative inline-flex size-8 items-center justify-center rounded-md text-neutral-500 hover:bg-primary-400/5 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
        >
          <UIcon name="i-simple-icons-github" class="size-4" />
        </a>
      </div>
      <RuleExplorer
        :rules="(rules || []) as RawRuleEntry[]"
        :title="`${meta.label} Doctor rules`"
        :description="`Browse every ${meta.label} Doctor rule by category, severity, and fixability.`"
        :current-framework="framework"
        :pack-label="meta.pack"
        framework-tabs-mode="links"
        heading-tag="h1"
      />
    </main>
  </div>
</template>
