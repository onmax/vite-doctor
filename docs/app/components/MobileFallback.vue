<script setup lang="ts">
const props = defineProps<{ framework?: "vue" | "nuxt"; reason?: string }>();

const reasonLabel = computed(() => {
  switch (props.reason) {
    case "mobile":
    case "small-screen":
      return "Open on desktop to run live";
    case "no-sab":
    case "no-coi":
      return "This browser session is missing WebContainer isolation headers";
    default:
      return "Live scanning is unavailable in this browser";
  }
});

const demoFindings = [
  {
    severity: "high",
    title: "v-html on untrusted input",
    description: "XSS risk: comment body bound with v-html.",
    location: "components/Comment.vue:42",
  },
  {
    severity: "medium",
    title: "Async function in computed()",
    description: "Computed must be synchronous.",
    location: "composables/useTotals.ts:7",
  },
  {
    severity: "low",
    title: "window used in setup",
    description: "Browser API runs during SSR.",
    location: "composables/useScroll.ts:3",
  },
];
</script>

<template>
  <section class="overflow-hidden bg-white dark:bg-neutral-900">
    <div
      class="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-neutral-100 px-6 py-3.5 text-sm dark:border-neutral-800"
    >
      <span class="inline-flex items-center gap-2">
        <span class="inline-block size-1.5 bg-emerald-500" aria-hidden="true" />
        <span class="font-medium text-neutral-900 dark:text-neutral-100">Sample scan</span>
      </span>
      <span
        class="hidden h-3 w-px bg-neutral-200 sm:inline-block dark:bg-neutral-800"
        aria-hidden="true"
      />
      <span class="text-neutral-500 dark:text-neutral-500">{{ reasonLabel }}</span>
    </div>
    <div
      class="flex flex-col gap-6 px-6 py-7 sm:grid sm:grid-cols-[auto_1fr] sm:items-center sm:gap-8 sm:px-8"
    >
      <div class="flex flex-col items-center">
        <svg viewBox="0 0 130 80" class="w-36 sm:w-40" aria-hidden="true">
          <path
            d="M 15 65 A 50 50 0 0 1 115 65"
            fill="none"
            stroke="currentColor"
            stroke-width="9"
            class="text-neutral-200 dark:text-neutral-800"
          />
          <path
            d="M 15 65 A 50 50 0 0 1 115 65"
            fill="none"
            stroke="#10b981"
            stroke-width="9"
            stroke-dasharray="66 157"
          />
        </svg>
        <div class="-mt-7 flex items-baseline gap-1">
          <span class="text-4xl font-semibold tabular-nums text-neutral-900 dark:text-neutral-100"
            >42</span
          >
          <span class="text-sm text-neutral-500">/ 100</span>
        </div>
      </div>
      <div
        class="border-t border-neutral-100 pt-6 sm:border-t-0 sm:border-l sm:pt-0 sm:pl-8 dark:border-neutral-800"
      >
        <div class="flex items-baseline gap-2">
          <span class="text-4xl font-semibold tabular-nums text-neutral-900 dark:text-neutral-100"
            >16</span
          >
          <span class="text-base font-medium text-neutral-700 dark:text-neutral-300"
            >issues found</span
          >
        </div>
        <p class="mt-1 text-sm text-neutral-500 dark:text-neutral-500">across 128 files</p>
      </div>
    </div>
    <div class="border-t border-neutral-100 px-6 pt-4 sm:px-8 dark:border-neutral-800">
      <ul role="list">
        <li
          v-for="f in demoFindings"
          :key="f.location"
          class="flex flex-col gap-2 border-t border-neutral-100 py-4 sm:grid sm:grid-cols-[100px_minmax(0,1fr)_220px] sm:items-start sm:gap-4 dark:border-neutral-800"
        >
          <span class="inline-flex items-center gap-2">
            <span
              class="inline-block size-1.5 shrink-0"
              :class="{
                'bg-rose-500': f.severity === 'high',
                'bg-amber-500': f.severity === 'medium',
                'bg-sky-500': f.severity === 'low',
              }"
            />
            <span
              class="text-sm font-medium capitalize"
              :class="{
                'text-rose-700 dark:text-rose-300': f.severity === 'high',
                'text-amber-700 dark:text-amber-300': f.severity === 'medium',
                'text-sky-700 dark:text-sky-300': f.severity === 'low',
              }"
              >{{ f.severity }}</span
            >
          </span>
          <div class="min-w-0">
            <p class="text-sm font-medium text-neutral-900 dark:text-neutral-100">{{ f.title }}</p>
            <p class="mt-0.5 text-sm text-neutral-500 dark:text-neutral-500">{{ f.description }}</p>
          </div>
          <code class="truncate font-mono text-xs text-neutral-500 dark:text-neutral-500">{{
            f.location
          }}</code>
        </li>
      </ul>
    </div>
  </section>
</template>
