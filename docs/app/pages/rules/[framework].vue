<script setup lang="ts">
import { queryCollection } from "#imports";

definePageMeta({
  header: false,
  footer: false,
  layout: false,
  validate: (route) => ["vue", "nuxt"].includes(String(route.params.framework)),
});

interface RuleEntry {
  path: string;
  title: string;
  description: string;
  ruleId: string;
  pack: string;
  severity: "error" | "warn" | "info";
  category: string;
  fix: "safe" | "suggestion" | "no";
}

const route = useRoute();
const framework = computed(() => String(route.params.framework) as "vue" | "nuxt");

const META: Record<
  "vue" | "nuxt",
  { label: string; pack: string; icon: string; other: "vue" | "nuxt"; otherLabel: string }
> = {
  vue: {
    label: "Vue",
    pack: "vue-doctor",
    icon: "i-logos-vue",
    other: "nuxt",
    otherLabel: "Nuxt",
  },
  nuxt: {
    label: "Nuxt",
    pack: "nuxt-doctor",
    icon: "i-logos-nuxt-icon",
    other: "vue",
    otherLabel: "Vue",
  },
};

const meta = computed(() => META[framework.value]);

useHead(() => ({
  title: `${meta.value.label} Doctor rules — every check, one page.`,
  meta: [
    {
      name: "description",
      content: `Browse every ${meta.value.label} Doctor rule by category, severity, and fix-ability.`,
    },
  ],
  link: [
    { rel: "preconnect", href: "https://fonts.googleapis.com" },
    { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" },
    {
      rel: "stylesheet",
      href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&display=swap",
    },
  ],
}));

const { data: rules } = await useAsyncData(
  () => `rules-${framework.value}`,
  async () => {
    const collection = queryCollection("docs" as never) as unknown as {
      where: (k: string, op: string, v: string) => unknown;
    };
    const builder = collection.where("path", "LIKE", `/${framework.value}/rules/%`) as {
      order: (k: string, dir: string) => unknown;
    };
    const ordered = builder.order("path", "ASC") as { all: () => Promise<unknown[]> };
    const items = (await ordered.all()) as Array<Partial<RuleEntry> & { path: string }>;
    return items.filter((r): r is RuleEntry => Boolean(r.ruleId));
  },
  { watch: [framework] },
);

interface Group {
  category: string;
  rules: RuleEntry[];
}

const CATEGORY_LABELS: Record<string, string> = {
  "app-config": "App config",
  architecture: "Architecture",
  auth: "Authentication",
  "browser-api": "Browser APIs",
  cache: "Caching",
  composables: "Composables",
  computed: "Computed",
  content: "Content",
  context: "Context",
  fetch: "Data fetching",
  fetching: "Data fetching",
  hydration: "Hydration & SSR",
  images: "Images",
  imports: "Imports",
  layers: "Layers",
  lifecycle: "Lifecycle",
  links: "Links",
  middleware: "Middleware",
  plugins: "Plugins",
  project: "Project",
  reactivity: "Reactivity",
  routing: "Routing",
  runtime: "Runtime config",
  "runtime-config": "Runtime config",
  scripts: "Scripts",
  security: "Security",
  seo: "SEO",
  shared: "Shared",
  ssr: "SSR safety",
  state: "State",
  style: "Style",
  template: "Template",
  ui: "UI",
  watch: "Watchers",
};

const grouped = computed<Group[]>(() => {
  const map = new Map<string, RuleEntry[]>();
  for (const r of rules.value ?? []) {
    const arr = map.get(r.category) ?? [];
    arr.push(r);
    map.set(r.category, arr);
  }
  return [...map.entries()]
    .map(([category, rules]) => ({
      category,
      rules: rules.slice().sort((a, b) => a.title.localeCompare(b.title)),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
});

const totalRules = computed(() => rules.value?.length ?? 0);

function categoryLabel(slug: string) {
  return CATEGORY_LABELS[slug] ?? slug.replace(/-/g, " ");
}

function ruleSlug(ruleId: string) {
  return ruleId.split("/").pop() ?? ruleId;
}

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
    <header class="mx-auto flex max-w-4xl items-center justify-between px-6 pt-6 sm:px-10 sm:pt-7">
      <a
        href="/"
        aria-label="Homepage"
        class="inline-flex items-center gap-2.5 rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-500"
      >
        <span
          class="inline-flex size-7 items-center justify-center rounded-md bg-emerald-600 text-white dark:bg-emerald-500"
          aria-hidden="true"
        >
          <svg
            viewBox="0 0 20 20"
            class="size-3.5"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="square"
            stroke-linejoin="miter"
          >
            <path d="M5 7l3 3-3 3" />
            <path d="M10 13h5" />
          </svg>
        </span>
        <span class="text-base font-semibold tracking-tight">Doctor</span>
      </a>

      <nav class="flex items-center gap-0.5 sm:gap-1">
        <a
          href="/"
          class="rounded-md px-2.5 py-1.5 text-sm font-medium text-neutral-600 hover:text-neutral-900 sm:px-3 dark:text-neutral-400 dark:hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
        >
          Home
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
            class="hidden size-3.5 shrink-0 sm:inline-block"
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

    <main class="mx-auto max-w-4xl px-6 pb-20 sm:px-10">
      <section class="pt-10 pb-10 sm:pt-14 lg:pt-16">
        <p
          class="inline-flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-500"
        >
          <UIcon :name="meta.icon" class="size-3.5 shrink-0" aria-hidden="true" />
          {{ meta.label }} rules
        </p>

        <h1
          class="mt-3 max-w-[24ch] text-4xl font-semibold tracking-tight text-balance text-neutral-900 sm:text-5xl dark:text-neutral-100"
        >
          {{ totalRules }} {{ meta.label }} rules. One page.
        </h1>
        <p class="mt-4 max-w-[60ch] text-base text-pretty text-neutral-600 dark:text-neutral-400">
          Every check Doctor runs against
          <code class="font-mono text-neutral-700 dark:text-neutral-300">{{ meta.pack }}</code
          >, grouped by category. Severity, fix-ability, and rule ID are listed inline.
        </p>

        <div
          class="mt-7 inline-flex items-center gap-1 rounded-full bg-neutral-100/70 p-1 text-sm ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-800"
          role="tablist"
          aria-label="Framework"
        >
          <a
            v-for="fw in ['vue', 'nuxt'] as const"
            :key="fw"
            :href="`/rules/${fw}`"
            role="tab"
            :aria-selected="framework === fw"
            class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium transition-transform duration-100 active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
            :class="
              framework === fw
                ? 'bg-white text-neutral-900 ring-1 ring-neutral-200 dark:bg-neutral-800 dark:text-neutral-100 dark:ring-neutral-700'
                : 'text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100'
            "
          >
            <UIcon
              :name="fw === 'vue' ? 'i-logos-vue' : 'i-logos-nuxt-icon'"
              class="size-3.5 shrink-0"
              aria-hidden="true"
            />
            {{ fw === "vue" ? "Vue" : "Nuxt" }}
          </a>
        </div>

        <dl
          class="mt-6 grid grid-cols-3 gap-x-6 gap-y-1 max-w-md text-sm text-neutral-600 dark:text-neutral-400"
        >
          <div class="flex items-center gap-2">
            <span class="inline-block size-1.5 bg-rose-500" aria-hidden="true" />
            <dt class="font-medium text-neutral-700 dark:text-neutral-300">error</dt>
          </div>
          <div class="flex items-center gap-2">
            <span class="inline-block size-1.5 bg-amber-500" aria-hidden="true" />
            <dt class="font-medium text-neutral-700 dark:text-neutral-300">warn</dt>
          </div>
          <div class="flex items-center gap-2">
            <span class="inline-block size-1.5 bg-sky-500" aria-hidden="true" />
            <dt class="font-medium text-neutral-700 dark:text-neutral-300">info</dt>
          </div>
        </dl>
      </section>

      <section
        v-for="g in grouped"
        :key="g.category"
        class="border-t border-neutral-200/70 py-8 first:border-t-0 first:pt-0 dark:border-neutral-800/70"
      >
        <header class="flex items-baseline justify-between gap-4">
          <h2 class="text-xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
            {{ categoryLabel(g.category) }}
          </h2>
          <span class="text-xs font-medium uppercase tracking-wider text-neutral-500 tabular-nums">
            {{ g.rules.length }} {{ g.rules.length === 1 ? "rule" : "rules" }}
          </span>
        </header>

        <ul role="list" class="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <li v-for="r in g.rules" :key="r.ruleId">
            <a
              :href="r.path"
              class="group relative flex items-start gap-3 rounded-md px-3 py-3 ring-1 ring-neutral-200 transition-colors hover:bg-neutral-50 hover:ring-neutral-300 dark:ring-neutral-800 dark:hover:bg-neutral-900 dark:hover:ring-neutral-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
            >
              <span
                class="mt-1.5 inline-block size-1.5 shrink-0"
                :class="{
                  'bg-rose-500': r.severity === 'error',
                  'bg-amber-500': r.severity === 'warn',
                  'bg-sky-500': r.severity === 'info',
                }"
                aria-hidden="true"
              />
              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium text-neutral-900 text-pretty dark:text-neutral-100">
                  {{ r.title }}
                </p>
                <p
                  class="mt-1 truncate font-mono text-[0.75rem] text-neutral-500 dark:text-neutral-500"
                  :title="r.ruleId"
                >
                  {{ ruleSlug(r.ruleId) }}
                </p>
              </div>
              <span
                v-if="r.fix && r.fix !== 'no'"
                class="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[0.6875rem] font-medium text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/20"
                :title="r.fix === 'safe' ? 'Auto-fix is safe' : 'Suggested fix available'"
              >
                <UIcon name="i-lucide-wand-sparkles" class="size-3 shrink-0" aria-hidden="true" />
                {{ r.fix === "safe" ? "auto-fix" : "fix" }}
              </span>
              <UIcon
                name="i-lucide-arrow-up-right"
                class="size-3.5 shrink-0 text-neutral-400 transition-colors group-hover:text-emerald-600 dark:group-hover:text-emerald-400"
                aria-hidden="true"
              />
            </a>
          </li>
        </ul>
      </section>

      <p
        v-if="!grouped.length"
        class="border-t border-neutral-200/70 py-12 text-center text-sm text-neutral-500 dark:border-neutral-800/70"
      >
        No rules found. Check the content database is populated.
      </p>

      <nav
        class="mt-10 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-neutral-200/70 pt-8 text-sm dark:border-neutral-800/70"
      >
        <a
          href="/"
          class="inline-flex items-center gap-1.5 rounded-md font-medium text-emerald-700 hover:text-emerald-800 dark:text-emerald-400 dark:hover:text-emerald-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
        >
          <UIcon name="i-lucide-arrow-left" class="size-3.5 shrink-0" aria-hidden="true" />
          Back to home
        </a>
        <span class="h-3 w-px bg-neutral-200 dark:bg-neutral-800" aria-hidden="true" />
        <a
          :href="`/rules/${meta.other}`"
          class="rounded-md text-neutral-500 hover:text-neutral-900 dark:text-neutral-500 dark:hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
        >
          {{ meta.otherLabel }} rules instead →
        </a>
      </nav>
    </main>
  </div>
</template>
