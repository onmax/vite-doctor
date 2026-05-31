<script setup lang="ts">
definePageMeta({ header: false, footer: false, layout: false });

const homeTitle = "Catch the AI slop your agents ship.";
const homeDescription =
  "Doctor scans your project before review and flags framework bugs agents often miss.";

useSeoMeta({
  title: homeTitle,
  description: homeDescription,
  ogTitle: homeTitle,
  ogDescription: homeDescription,
  ogSiteName: "Doctor",
  ogType: "website",
  ogUrl: "https://vite-doctor.onmax.me/",
  twitterCard: "summary_large_image",
  twitterTitle: homeTitle,
  twitterDescription: homeDescription,
});

defineOgImageComponent(
  "DoctorHome",
  {
    title: homeTitle,
    description: homeDescription,
  },
  {
    width: 1200,
    height: 630,
  },
);

useHead({
  titleTemplate: "%s",
  meta: [
    { name: "theme-color", content: "#059669" },
    { name: "application-name", content: "Doctor" },
  ],
  link: [
    { rel: "canonical", href: "https://vite-doctor.onmax.me/" },
    { rel: "preconnect", href: "https://fonts.googleapis.com" },
    { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" },
    {
      rel: "stylesheet",
      href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&display=swap",
    },
  ],
});

const tracks = [
  {
    id: "nuxt",
    label: "Nuxt",
    icon: "i-logos-nuxt-icon",
    to: "/nuxt",
    description: "Install the Nuxt module and fix app, Vue, Nitro, and Vite diagnostics.",
  },
  {
    id: "vue",
    label: "Vue",
    icon: "i-logos-vue",
    to: "/vue",
    description: "Catch reactivity, lifecycle, watcher, template, SSR, and security issues.",
  },
  {
    id: "vite",
    label: "Vite",
    icon: "i-logos-vitejs",
    to: "/vite",
    description: "Find env, define, server-only import, SSR, asset, worker, and HMR risks.",
  },
  {
    id: "nitro",
    label: "Nitro",
    icon: "i-unjs-nitro",
    to: "/nitro",
    description: "Fix request validation, runtime config, and server-boundary diagnostics.",
  },
] as const;

type HomeFeature = {
  id: string;
  icon: string;
  title: string;
  description: string;
  href?: string;
};

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
    id: "nostics",
    icon: "i-lucide-stethoscope",
    title: "Rendered with nostics",
    description: "Doctor emits diagnostics with shared why, fix, docs, and source fields.",
    href: "https://npmx.dev/package/nostics",
  },
] as const satisfies readonly HomeFeature[];

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
        <img src="/doctor-icon.png" alt="" class="size-7 rounded-md" aria-hidden="true" />
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
          v-for="track in tracks"
          :key="track.id"
          :href="track.to"
          class="rounded-md px-2.5 py-1.5 text-sm font-medium text-neutral-600 hover:text-neutral-900 sm:px-3 dark:text-neutral-400 dark:hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
        >
          {{ track.label }}
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
            {{ homeTitle }}
          </h1>
          <p
            class="mt-6 max-w-[48ch] text-lg text-pretty text-neutral-600 md:max-w-[58ch] dark:text-neutral-400"
          >
            {{ homeDescription }}
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
            class="border-neutral-950/10 py-5 not-first:border-t md:px-6 md:py-6 md:not-first:border-t-0 md:not-first:border-l md:first:pl-0 md:first:pr-6 md:last:pr-0 md:last:pl-6 dark:border-white/10"
          >
            <component
              :is="feature.href ? 'a' : 'div'"
              v-bind="
                feature.href
                  ? { href: feature.href, target: '_blank', rel: 'noopener noreferrer' }
                  : {}
              "
              class="grid grid-cols-[1rem_minmax(0,1fr)] items-start gap-x-3 gap-y-2.5 rounded-md"
              :class="
                feature.href
                  ? '-m-2 p-2 transition-colors hover:bg-neutral-50 dark:hover:bg-white/[0.03] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-500'
                  : ''
              "
            >
              <UIcon
                :name="feature.icon"
                class="h-lh size-4 shrink-0 text-neutral-500 dark:text-neutral-400"
                aria-hidden="true"
              />
              <dt
                class="inline-flex min-w-0 items-baseline gap-1.5 text-sm font-semibold tracking-tight text-neutral-950 dark:text-neutral-50"
              >
                <span class="min-w-0">{{ feature.title }}</span>
                <UIcon
                  v-if="feature.href"
                  name="i-lucide-arrow-up-right"
                  class="size-3.5 shrink-0 text-neutral-400 dark:text-neutral-500"
                  aria-hidden="true"
                />
              </dt>
              <dd
                class="col-start-2 text-sm leading-6 text-pretty text-neutral-600 dark:text-neutral-400"
              >
                {{ feature.description }}
              </dd>
            </component>
          </div>
        </dl>
      </section>

      <section id="rules" class="pb-14">
        <div class="mb-5 max-w-2xl">
          <p class="text-sm font-medium text-emerald-600 dark:text-emerald-400">
            Start with your runtime
          </p>
          <h2
            class="mt-2 text-2xl font-semibold tracking-tight text-neutral-950 dark:text-neutral-50"
          >
            Use the docs that match the diagnostic prefix.
          </h2>
          <p class="mt-3 text-sm leading-6 text-neutral-600 dark:text-neutral-400">
            Doctor keeps Nuxt, Vue, Vite, and Nitro in separate rule packs. Choose the framework
            page first, then open the rule page for the exact diagnostic you are fixing.
          </p>
        </div>
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <NuxtLink
            v-for="track in tracks"
            :key="track.id"
            :to="track.to"
            class="group rounded-lg border border-neutral-950/10 p-4 transition-colors hover:border-emerald-500/40 hover:bg-emerald-50/40 dark:border-white/10 dark:hover:border-emerald-400/30 dark:hover:bg-emerald-400/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
          >
            <span
              class="flex items-center gap-2 text-sm font-semibold text-neutral-950 dark:text-neutral-50"
            >
              <UIcon :name="track.icon" class="size-4 shrink-0" aria-hidden="true" />
              {{ track.label }}
              <UIcon
                name="i-lucide-arrow-right"
                class="ml-auto size-4 shrink-0 text-neutral-400 transition-transform group-hover:translate-x-0.5"
                aria-hidden="true"
              />
            </span>
            <span class="mt-3 block text-sm leading-6 text-neutral-600 dark:text-neutral-400">
              {{ track.description }}
            </span>
          </NuxtLink>
        </div>
      </section>
    </main>
  </div>
</template>
