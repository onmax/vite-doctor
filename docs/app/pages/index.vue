<script setup lang="ts">
import type { RawRuleEntry } from "../utils/rule-catalog";

definePageMeta({ header: false, footer: false, layout: false });

useHead({
  title: "Vue Doctor & Nuxt Doctor. Framework-aware rule checks.",
  meta: [
    {
      name: "description",
      content:
        "Static build analysis for framework code. Doctor catches reactivity, hydration, runtime config, and server-boundary bugs before review.",
    },
    { name: "twitter:card", content: "summary_large_image" },
  ],
  link: [
    { rel: "preconnect", href: "https://fonts.googleapis.com" },
    { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" },
    {
      rel: "stylesheet",
      href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&display=swap",
    },
  ],
});

const { data: allRules } = await useAsyncData("home-rules", () => queryCollection("rules").all());

const tracks = [
  { id: "nuxt", label: "Nuxt", icon: "i-logos-nuxt-icon", to: "/rules/nuxt" },
  { id: "vue", label: "Vue", icon: "i-logos-vue", to: "/rules/vue" },
  { id: "nitro", label: "Nitro", icon: "i-unjs-nitro", to: "/rules/nitro" },
  { id: "vite", label: "Vite", icon: "i-logos-vitejs", to: "/rules/vite" },
] as const;

const features = [
  {
    id: "static",
    icon: "i-lucide-scan-line",
    title: "Catch framework bugs before review",
    description:
      "Find hydration, reactivity, config, and server issues while they are cheap to fix.",
  },
  {
    id: "workflow",
    icon: "i-lucide-terminal",
    title: "Use the workflow you already trust",
    description: "Run the same checks your project already uses, locally or in CI.",
  },
  {
    id: "agents",
    icon: "i-lucide-bot",
    title: "Show agents the real project state",
    description: "Send rule results, file paths, and framework evidence they can act on.",
  },
] as const;

const colorMode = useColorMode();
const isDark = computed(() => colorMode.value === "dark");
function toggleTheme() {
  colorMode.preference = isDark.value ? "light" : "dark";
}
</script>

<template>
  <div
    class="relative min-h-dvh w-full antialiased isolate overflow-hidden bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100 selection:bg-emerald-500/20 selection:text-emerald-900 dark:selection:text-emerald-50"
  >
    <header class="mx-auto flex max-w-6xl items-center justify-between px-6 pt-6 sm:px-10 sm:pt-7">
      <a
        href="/"
        aria-label="Homepage"
        class="inline-flex items-center gap-2.5 rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-500"
      >
        <span
          class="inline-flex size-7 items-center justify-center rounded-md bg-emerald-600 text-white dark:bg-emerald-500"
          aria-hidden="true"
        >
          <UIcon name="i-lucide-stethoscope" class="size-4" />
        </span>
        <span class="text-base font-semibold tracking-tight">Doctor</span>
      </a>

      <nav class="flex items-center gap-0.5 sm:gap-1">
        <a
          href="/cli"
          class="rounded-md px-2.5 py-1.5 text-sm font-medium text-neutral-600 hover:text-neutral-900 sm:px-3 dark:text-neutral-400 dark:hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
        >
          CLI
        </a>
        <a
          href="/rules/nuxt"
          class="rounded-md px-2.5 py-1.5 text-sm font-medium text-neutral-600 hover:text-neutral-900 sm:px-3 dark:text-neutral-400 dark:hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
        >
          Rules
        </a>
        <a
          href="https://github.com/onmax/nuxt-doctor"
          target="_blank"
          rel="noopener"
          class="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-sm font-medium text-neutral-600 hover:text-neutral-900 sm:px-3 dark:text-neutral-400 dark:hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
        >
          GitHub
          <UIcon
            name="i-lucide-arrow-up-right"
            class="size-3.5 shrink-0 max-sm:hidden"
            aria-hidden="true"
          />
        </a>
        <button
          type="button"
          :aria-label="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
          class="relative ml-1 inline-flex size-8 items-center justify-center rounded-md text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-900 dark:hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
          @click="toggleTheme"
        >
          <UIcon
            :name="isDark ? 'i-lucide-sun' : 'i-lucide-moon'"
            class="size-4"
            aria-hidden="true"
          />
        </button>
      </nav>
    </header>

    <main class="mx-auto max-w-6xl px-6 pb-20 sm:px-10">
      <section
        class="grid items-start gap-7 py-10 sm:gap-9 sm:pt-16 lg:grid-cols-[minmax(0,21fr)_minmax(0,20fr)] lg:gap-16 lg:pt-20"
      >
        <div class="min-w-0">
          <div
            class="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2"
            aria-label="Supported rule packs"
          >
            <span
              v-for="track in tracks"
              :key="track.id"
              class="inline-flex items-center gap-1.5 text-[0.8125rem] font-medium text-neutral-600 dark:text-neutral-400"
            >
              <UIcon :name="track.icon" class="size-4 shrink-0" aria-hidden="true" />
              <span class="leading-none">{{ track.label }}</span>
            </span>
          </div>
          <h1
            class="max-w-[18ch] text-4xl font-semibold tracking-tight text-balance text-neutral-900 sm:text-5xl lg:text-[3.5rem] dark:text-neutral-100"
          >
            Catch the AI slop your agents ship.
          </h1>
          <p
            class="mt-6 max-w-[48ch] text-lg text-pretty text-neutral-600 md:max-w-[58ch] dark:text-neutral-400"
          >
            Doctor scans your project before review and flags framework bugs agents often miss.
          </p>

          <InstallCommands class="mt-6 sm:mt-7" />
        </div>

        <div class="relative min-w-0">
          <div
            class="overflow-hidden rounded-lg bg-[#0a0a0a] shadow-lg shadow-neutral-950/15 ring-1 ring-neutral-950/90 dark:shadow-black/30 dark:ring-white/10"
          >
            <div
              class="flex items-center gap-2 border-b border-white/[0.08] bg-white/[0.025] px-4 py-2 text-xs font-medium text-neutral-500 sm:py-2.5"
            >
              <span class="inline-flex size-2 rounded-full bg-[#ff5f57]/80" aria-hidden="true" />
              <span class="inline-flex size-2 rounded-full bg-[#ffbd2e]/80" aria-hidden="true" />
              <span class="inline-flex size-2 rounded-full bg-[#28c840]/80" aria-hidden="true" />
              <span class="ml-2 min-w-0 truncate font-mono text-neutral-500">~/your-app</span>
              <span class="ml-auto hidden font-mono text-neutral-500 sm:inline">vite-doctor</span>
            </div>
            <div
              class="space-y-2.5 px-4.5 py-4 font-mono text-[0.75rem]/5 text-neutral-300 sm:space-y-3 sm:px-5 sm:py-5 sm:text-[0.8125rem]/6"
            >
              <p class="flex items-start gap-2">
                <span class="select-none text-emerald-400/90" aria-hidden="true">$</span>
                <span class="min-w-0 break-words text-neutral-100/95">
                  pnpm dlx vite-doctor@alpha . --rules nuxt/hydration
                </span>
              </p>
              <div class="space-y-1">
                <p class="flex items-start gap-2">
                  <UIcon
                    name="i-lucide-check"
                    class="mt-1 size-3.5 shrink-0 text-emerald-400/90"
                    aria-hidden="true"
                  />
                  <span class="min-w-0">Detected Nuxt 4 app with Vue, Nitro, and Vite rules</span>
                </p>
                <p class="flex items-start gap-2">
                  <UIcon
                    name="i-lucide-search"
                    class="mt-1 size-3.5 shrink-0 text-neutral-500"
                    aria-hidden="true"
                  />
                  <span class="min-w-0 text-neutral-400"
                    >Scanned 42 files, 11 server handlers, 8 route entries</span
                  >
                </p>
              </div>
              <div class="space-y-2.5 border-t border-white/[0.08] pt-2.5 sm:pt-3">
                <div class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5">
                  <UIcon
                    name="i-lucide-triangle-alert"
                    class="mt-1 size-3.5 text-amber-300/90"
                    aria-hidden="true"
                  />
                  <div class="min-w-0">
                    <p class="break-words font-medium text-neutral-100">
                      nuxt/hydration/no-client-conditional-in-template
                    </p>
                    <p class="break-words text-neutral-600">app/components/UserMenu.vue:18:5</p>
                  </div>
                </div>
                <div class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5">
                  <UIcon
                    name="i-lucide-circle-alert"
                    class="mt-1 size-3.5 text-rose-300/90"
                    aria-hidden="true"
                  />
                  <div class="min-w-0">
                    <p class="break-words font-medium text-neutral-100">
                      nuxt/runtime/no-secret-in-public-config
                    </p>
                    <p class="break-words text-neutral-600">nuxt.config.ts:42:13</p>
                  </div>
                </div>
              </div>
              <div
                class="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-white/[0.08] pt-2.5 text-neutral-500 sm:pt-3"
              >
                <span class="font-medium text-neutral-200">2 high</span>
                <span class="text-neutral-700" aria-hidden="true">/</span>
                <span>13 warnings</span>
                <span class="text-neutral-700" aria-hidden="true">/</span>
                <span class="inline-flex items-center gap-1 text-emerald-300/90">
                  <UIcon name="i-lucide-file-search" class="size-3.5" aria-hidden="true" />
                  report ready
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section aria-label="Features" class="pb-14">
        <dl class="grid bg-white md:grid-cols-3 dark:bg-neutral-950">
          <div
            v-for="feature in features"
            :key="feature.id"
            class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-neutral-950/10 py-5 not-first:border-t md:block md:px-6 md:py-6 md:not-first:border-t-0 md:not-first:border-l md:first:pl-0 md:first:pr-6 md:last:pr-0 md:last:pl-6 dark:border-white/10"
          >
            <span
              class="row-span-2 inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-neutral-50 text-neutral-700 ring-1 ring-neutral-950/10 md:mb-4 dark:bg-white/[0.03] dark:text-neutral-300 dark:ring-white/10"
              aria-hidden="true"
            >
              <UIcon :name="feature.icon" class="size-4" />
            </span>
            <dt
              class="self-center text-sm font-semibold tracking-tight text-neutral-950 dark:text-neutral-50"
            >
              {{ feature.title }}
            </dt>
            <dd
              class="col-start-2 text-sm text-pretty text-neutral-600 md:col-start-auto dark:text-neutral-400"
            >
              {{ feature.description }}
            </dd>
          </div>
        </dl>
      </section>

      <section id="rules" class="pb-14">
        <RuleExplorer
          :rules="(allRules || []) as RawRuleEntry[]"
          title="Doctor rules"
          current-framework="all"
          framework-tabs-mode="filter"
        />
      </section>
    </main>
  </div>
</template>

<style scoped>
.command-swap-enter-active,
.command-swap-leave-active {
  transition:
    opacity 150ms ease,
    filter 150ms ease;
}

.command-swap-enter-from,
.command-swap-leave-to {
  opacity: 0;
  filter: blur(1px);
}

.copy-icon-enter-active,
.copy-icon-leave-active {
  transition:
    opacity 200ms cubic-bezier(0.23, 1, 0.32, 1),
    filter 200ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 200ms cubic-bezier(0.23, 1, 0.32, 1);
}

.copy-icon-enter-from,
.copy-icon-leave-to {
  opacity: 0;
  filter: blur(1px);
  transform: scale(0.5);
}

@media (prefers-reduced-motion: reduce) {
  .command-swap-enter-active,
  .command-swap-leave-active,
  .copy-icon-enter-active,
  .copy-icon-leave-active {
    transition-duration: 0ms;
  }
}
</style>
