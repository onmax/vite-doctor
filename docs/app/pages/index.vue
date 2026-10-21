<script setup lang="ts">
import { homeDescription, homeTitle } from "../utils/home-copy";

definePageMeta({ header: false, footer: false, layout: false });

useSeoMeta({
  title: homeTitle,
  description: homeDescription,
  ogTitle: homeTitle,
  ogDescription: homeDescription,
  ogSiteName: "Doctor",
  ogType: "website",
  ogUrl: "https://vite-doctor.onmax.me/",
  ogImage: {
    url: "https://vite-doctor.onmax.me/og/doctor-home.png",
    width: 1200,
    height: 630,
    type: "image/png",
    alt: "Vite Doctor: catch the AI slop your agents ship.",
  },
  twitterCard: "summary_large_image",
  twitterTitle: homeTitle,
  twitterDescription: homeDescription,
  twitterImage: "https://vite-doctor.onmax.me/og/doctor-home.png",
});

useHead({
  titleTemplate: "%s",
  meta: [
    { name: "theme-color", content: "#059669" },
    { name: "application-name", content: "Doctor" },
  ],
  link: [{ rel: "canonical", href: "https://vite-doctor.onmax.me/" }],
});

const tracks = [
  { id: "nuxt", label: "Nuxt", icon: "i-logos-nuxt-icon", to: "/nuxt", prefix: "NUXT" },
  { id: "vue", label: "Vue", icon: "i-logos-vue", to: "/vue", prefix: "VUE" },
  { id: "vite", label: "Vite", icon: "i-logos-vitejs", to: "/vite", prefix: "VITE" },
  { id: "nitro", label: "Nitro", icon: "i-unjs-nitro", to: "/nitro", prefix: "NITRO" },
  { id: "pinia", label: "Pinia", icon: "i-logos-pinia", to: "/pinia", prefix: "PINIA" },
  {
    id: "typescript",
    label: "TypeScript",
    icon: "i-logos-typescript-icon",
    to: "/typescript",
    prefix: "TS",
  },
] as const;

const navTracks = tracks.slice(0, 4);

const surfaces = [
  {
    id: "cli",
    icon: "i-lucide-square-terminal",
    title: "CLI",
    to: "/cli",
    code: "vite-doctor .",
    description:
      "reports each finding with its file, range, Diagnostic Code, and fix. Text, agent, JSON, and SARIF output.",
  },
  {
    id: "nuxt",
    icon: "i-lucide-mountain",
    title: "Nuxt module",
    to: "/nuxt",
    code: "nuxt doctor",
    description:
      "runs with the Project Inventory the module writes, following Nuxt to the Nitro and H3 it actually loads.",
  },
  {
    id: "vite",
    icon: "i-lucide-plug",
    title: "Vite plugin",
    to: "/vite",
    code: "doctor()",
    description: "in vite.config.ts runs on build, dev, or both, and can fail the build on errors.",
  },
  {
    id: "agents",
    icon: "i-lucide-bot",
    title: "Agents",
    to: "/cli#use-doctor-from-an-agent",
    description:
      "Coding agents get a compact report with remediation, docs links, and verify commands. The skill tells them when to run it.",
  },
  {
    id: "migrate",
    icon: "i-lucide-git-compare-arrows",
    title: "Migrations",
    to: "/cli#check-a-migration-before-upgrading",
    code: "migrate --to nuxt@5",
    description: "separates what you can fix today from what has to land with the upgrade.",
  },
  {
    id: "extending",
    icon: "i-lucide-puzzle",
    title: "Extensions",
    to: "/extending",
    description:
      "Vite plugins and Nuxt modules ship their own Rules through api.doctor. Project Rules go in extensions.",
  },
] as const;

const skillHub = {
  url: "https://nuxt-skill.onmax.me",
  github: "https://github.com/onmax/nuxt-skill-hub",
  skillCommand: "npx skills add https://nuxt-skill.onmax.me/",
  moduleCommand: "npx nuxi module add nuxt-skill-hub",
};

const externalNavLinks = [
  {
    id: "x",
    label: "X",
    href: "https://x.com/_onmax",
    icon: "i-simple-icons-x",
    ariaLabel: "Onmax on X",
  },
  {
    id: "github",
    label: "GitHub",
    href: "https://github.com/onmax/vite-doctor",
    icon: "i-simple-icons-github",
    ariaLabel: "GitHub repository",
  },
] as const;

const footerLinks = [
  ...externalNavLinks,
  {
    id: "nuxt-skill",
    label: "Nuxt Skill Hub",
    href: skillHub.url,
    icon: "i-logos-nuxt-icon",
    ariaLabel: "Nuxt Skill Hub",
  },
] as const;

const colorMode = useColorMode();
const isDark = computed(() => colorMode.value === "dark");
function toggleTheme() {
  colorMode.preference = isDark.value ? "light" : "dark";
}

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500";
</script>

<template>
  <div
    class="home-page relative min-h-dvh w-full antialiased isolate bg-neutral-50 text-neutral-700 dark:bg-neutral-950 dark:text-neutral-300 selection:bg-emerald-500/20 selection:text-emerald-900 dark:selection:text-emerald-50"
  >
    <header
      class="sticky top-0 z-20 border-b border-neutral-950/10 bg-neutral-50/85 backdrop-blur dark:border-white/10 dark:bg-neutral-950/85"
    >
      <div class="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-6 sm:px-8">
        <NuxtLink
          to="/"
          aria-label="Homepage"
          class="inline-flex items-center gap-2.5 rounded-[0.375rem]"
          :class="focusRing"
        >
          <img src="/doctor-icon.png" alt="" class="size-7 rounded-[0.375rem]" aria-hidden="true" />
          <span class="text-base font-semibold tracking-tight text-neutral-950 dark:text-neutral-50"
            >Doctor</span
          >
        </NuxtLink>

        <nav class="flex min-w-0 items-center justify-end gap-0.5 sm:gap-1">
          <NuxtLink
            to="/cli"
            class="rounded-[0.375rem] px-2 py-1.5 text-sm text-neutral-600 hover:bg-neutral-200/60 hover:text-neutral-950 sm:px-2.5 dark:text-neutral-400 dark:hover:bg-white/5 dark:hover:text-neutral-100"
            :class="focusRing"
          >
            CLI
          </NuxtLink>
          <NuxtLink
            v-for="track in navTracks"
            :key="track.id"
            :to="track.to"
            class="hidden rounded-[0.375rem] px-2.5 py-1.5 text-sm text-neutral-600 hover:bg-neutral-200/60 hover:text-neutral-950 sm:inline-flex dark:text-neutral-400 dark:hover:bg-white/5 dark:hover:text-neutral-100"
            :class="focusRing"
          >
            {{ track.label }}
          </NuxtLink>
          <a
            v-for="link in externalNavLinks"
            :key="link.id"
            :href="link.href"
            :aria-label="link.ariaLabel"
            class="ml-0.5 inline-flex size-8 items-center justify-center rounded-[0.375rem] text-neutral-500 hover:bg-neutral-200/60 hover:text-neutral-950 dark:hover:bg-white/5 dark:hover:text-neutral-100"
            :class="focusRing"
            target="_blank"
            rel="noopener noreferrer"
          >
            <UIcon :name="link.icon" class="size-4" aria-hidden="true" />
          </a>
          <button
            type="button"
            :aria-label="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
            class="ml-0.5 inline-flex size-8 items-center justify-center rounded-[0.375rem] text-neutral-500 hover:bg-neutral-200/60 hover:text-neutral-950 dark:hover:bg-white/5 dark:hover:text-neutral-100"
            :class="focusRing"
            @click="toggleTheme"
          >
            <UIcon
              :name="isDark ? 'i-lucide-sun' : 'i-lucide-moon'"
              class="size-4"
              aria-hidden="true"
            />
          </button>
        </nav>
      </div>
    </header>

    <main class="mx-auto max-w-6xl px-6 sm:px-8">
      <section
        class="grid items-center gap-12 py-14 sm:py-20 lg:min-h-[calc(100dvh-4rem)] lg:grid-cols-2 lg:gap-16 lg:py-24"
      >
        <div class="min-w-0">
          <h1
            class="max-w-[14ch] text-5xl/[1] font-medium tracking-[-0.05em] text-balance text-neutral-950 sm:text-6xl/[1] dark:text-neutral-50"
          >
            {{ homeTitle }}
          </h1>
          <p
            class="mt-6 max-w-[34ch] text-lg/7 text-pretty text-neutral-600 sm:text-xl/8 dark:text-neutral-400"
          >
            {{ homeDescription }}
            For Nuxt, Vue, Vite, and Nitro, in the terminal, in CI, and in your agent's loop.
          </p>
          <div class="mt-9 flex flex-wrap items-center gap-x-6 gap-y-3">
            <NuxtLink
              to="/cli"
              class="inline-flex items-center gap-2 rounded-[0.375rem] bg-neutral-950 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800 dark:bg-white dark:text-neutral-950 dark:hover:bg-neutral-200"
              :class="focusRing"
            >
              Get started
              <UIcon name="i-lucide-arrow-right" class="size-4" aria-hidden="true" />
            </NuxtLink>
            <a
              href="https://github.com/onmax/vite-doctor"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-2 rounded-[0.375rem] text-sm font-medium text-neutral-950 hover:text-neutral-600 dark:text-neutral-50 dark:hover:text-neutral-300"
              :class="focusRing"
            >
              <UIcon name="i-simple-icons-github" class="size-4.5" aria-hidden="true" />
              View on GitHub
            </a>
          </div>
        </div>

        <HomeHeroShowcase />
      </section>

      <section aria-labelledby="surfaces-title" class="py-16 sm:py-24">
        <div class="mx-auto max-w-2xl text-center">
          <p class="home-eyebrow">// Surfaces //</p>
          <h2 id="surfaces-title" class="home-title mt-6">One Doctor Run, every place you work</h2>
          <p
            class="mt-4 text-base/7 text-pretty text-neutral-500 sm:text-lg/7 dark:text-neutral-400"
          >
            The CLI, the Nuxt module, the Vite plugin, and your agent share one Doctor Run, so they
            report the same Diagnostics.
          </p>
        </div>

        <div class="mt-14 grid gap-4 sm:mt-20 sm:grid-cols-2 lg:grid-cols-3 lg:gap-8">
          <NuxtLink
            v-for="surface in surfaces"
            :key="surface.id"
            :to="surface.to"
            class="group rounded-[0.75rem] border border-neutral-950/10 bg-neutral-50 p-6 transition-colors hover:border-neutral-950/20 hover:bg-white dark:border-white/10 dark:bg-neutral-950 dark:hover:border-white/20 dark:hover:bg-white/[0.02]"
            :class="focusRing"
          >
            <UIcon
              :name="surface.icon"
              class="size-6 text-neutral-800 dark:text-neutral-200"
              aria-hidden="true"
            />
            <h3 class="mt-8 font-medium text-neutral-950 dark:text-neutral-50">
              {{ surface.title }}
            </h3>
            <p class="mt-1.5 text-[0.9375rem]/7 text-pretty text-neutral-600 dark:text-neutral-400">
              <code
                v-if="'code' in surface"
                class="mr-1 rounded-[0.375rem] border border-neutral-950/10 bg-neutral-100 px-1.5 py-0.5 font-mono text-[0.8125rem] text-neutral-900 dark:border-white/10 dark:bg-white/5 dark:text-neutral-100"
                >{{ surface.code }}</code
              >{{ surface.description }}
            </p>
          </NuxtLink>
        </div>
      </section>

      <section aria-labelledby="rule-packs-title" class="py-16 sm:py-20">
        <div
          class="flex flex-col gap-6 border-t border-neutral-950/10 pt-14 lg:flex-row lg:items-end lg:justify-between dark:border-white/10"
        >
          <div class="max-w-xl">
            <p class="home-eyebrow">// Rule Packs //</p>
            <h2 id="rule-packs-title" class="home-title mt-6">
              Rules that read like the framework wrote them
            </h2>
            <p class="mt-4 text-base/7 text-pretty text-neutral-500 dark:text-neutral-400">
              Every Diagnostic Code starts with its framework prefix. Open the framework page, then
              the rule page for the code you are fixing.
            </p>
          </div>
          <NuxtLink
            to="/diagnostics/NUXT0032"
            class="inline-flex items-center gap-2 self-start rounded-[0.375rem] text-sm text-neutral-600 hover:text-neutral-950 lg:self-auto dark:text-neutral-400 dark:hover:text-neutral-100"
            :class="focusRing"
          >
            <span class="font-mono font-medium text-neutral-950 dark:text-neutral-50"
              >NUXT0032</span
            >
            Open a diagnostic page
            <UIcon name="i-lucide-arrow-right" class="size-3.5" aria-hidden="true" />
          </NuxtLink>
        </div>

        <div class="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <NuxtLink
            v-for="track in tracks"
            :key="track.id"
            :to="track.to"
            :aria-label="`${track.label} Rule Pack`"
            class="group flex items-center justify-between gap-3 rounded-[0.75rem] border border-neutral-950/10 px-4 py-3.5 transition-colors hover:border-neutral-950/20 hover:bg-white dark:border-white/10 dark:hover:border-white/20 dark:hover:bg-white/[0.02]"
            :class="focusRing"
          >
            <span class="inline-flex min-w-0 items-center gap-2.5">
              <UIcon :name="track.icon" class="size-5 shrink-0" aria-hidden="true" />
              <span class="truncate font-medium text-neutral-950 dark:text-neutral-50">{{
                track.label
              }}</span>
            </span>
            <span class="font-mono text-xs text-neutral-400 dark:text-neutral-500">{{
              track.prefix
            }}</span>
          </NuxtLink>
        </div>
      </section>

      <section aria-labelledby="quick-start-title" class="py-16 sm:py-24">
        <div class="max-w-xl">
          <p class="home-eyebrow">// Quick start //</p>
          <h2 id="quick-start-title" class="home-title mt-6">No config to start</h2>
          <p
            class="mt-4 text-base/7 text-pretty text-neutral-500 sm:text-lg/7 dark:text-neutral-400"
          >
            Run Doctor in the root of a project. It finds the frameworks from your dependencies and
            turns on their Rule Packs.
            <NuxtLink
              to="/cli"
              class="font-medium text-neutral-950 underline decoration-neutral-950/30 underline-offset-4 hover:decoration-neutral-950 dark:text-neutral-50 dark:decoration-white/30 dark:hover:decoration-white"
              >Read the CLI guide</NuxtLink
            >.
          </p>
        </div>
        <div class="mt-10">
          <HomeQuickStart />
        </div>
      </section>

      <section aria-labelledby="skill-hub-title" class="pt-8 pb-20 sm:pb-28">
        <div
          class="rounded-[1rem] border border-neutral-950/10 bg-neutral-100/70 px-6 py-16 text-center sm:px-12 sm:py-24 dark:border-white/10 dark:bg-white/[0.03]"
        >
          <p class="home-eyebrow inline-flex items-center gap-2">
            <UIcon name="i-logos-nuxt-icon" class="size-3.5" aria-hidden="true" />
            Nuxt Skill Hub
          </p>
          <h2 id="skill-hub-title" class="home-title mx-auto mt-6 max-w-[22ch]">
            Teach your agent the Nuxt way before it writes code
          </h2>
          <p
            class="mx-auto mt-4 max-w-[56ch] text-base/7 text-pretty text-neutral-600 sm:text-lg/8 dark:text-neutral-400"
          >
            Nuxt Skill Hub gives your agent Nuxt best practices, module APIs, and guidance generated
            from your stack. Doctor checks what it ships. Install the skill, or add the module to
            keep it in sync with your modules.
          </p>

          <div class="mx-auto mt-8 grid max-w-lg grid-cols-[minmax(0,1fr)] gap-4 text-left">
            <div>
              <p class="mb-1.5 text-xs font-medium text-neutral-500 dark:text-neutral-400">
                Nuxt Skill
              </p>
              <HomeCopyCommand :command="skillHub.skillCommand" />
            </div>
            <div>
              <p class="mb-1.5 text-xs font-medium text-neutral-500 dark:text-neutral-400">
                Nuxt Skill Hub module
              </p>
              <HomeCopyCommand :command="skillHub.moduleCommand" />
            </div>
          </div>

          <div class="mt-9 flex flex-wrap items-center justify-center gap-3">
            <a
              :href="skillHub.url"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-2 rounded-[0.375rem] bg-neutral-950 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800 dark:bg-white dark:text-neutral-950 dark:hover:bg-neutral-200"
              :class="focusRing"
            >
              Open Nuxt Skill Hub
              <UIcon name="i-lucide-arrow-up-right" class="size-4" aria-hidden="true" />
            </a>
            <a
              :href="skillHub.github"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-2 rounded-[0.375rem] border border-neutral-950/10 bg-neutral-200/60 px-3.5 py-2 text-sm font-medium text-neutral-950 transition-colors hover:bg-neutral-200 dark:border-white/10 dark:bg-white/5 dark:text-neutral-50 dark:hover:bg-white/10"
              :class="focusRing"
            >
              <UIcon name="i-simple-icons-github" class="size-4" aria-hidden="true" />
              nuxt-skill-hub
            </a>
          </div>
        </div>
      </section>
    </main>

    <footer class="border-t border-neutral-950/10 dark:border-white/10">
      <div
        class="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-6 text-sm sm:flex-row sm:items-center sm:justify-between sm:px-8"
      >
        <p class="text-neutral-500 dark:text-neutral-400">Doctor diagnostics for framework code.</p>
        <nav class="flex flex-wrap items-center gap-1" aria-label="External links">
          <a
            v-for="link in footerLinks"
            :key="link.id"
            :href="link.href"
            :aria-label="link.ariaLabel"
            class="inline-flex items-center gap-2 rounded-[0.375rem] px-2.5 py-1.5 text-neutral-600 hover:bg-neutral-200/60 hover:text-neutral-950 dark:text-neutral-400 dark:hover:bg-white/5 dark:hover:text-neutral-100"
            :class="focusRing"
            target="_blank"
            rel="noopener noreferrer"
          >
            <UIcon :name="link.icon" class="size-4 shrink-0" aria-hidden="true" />
            <span>{{ link.label }}</span>
          </a>
        </nav>
      </div>
    </footer>
  </div>
</template>
