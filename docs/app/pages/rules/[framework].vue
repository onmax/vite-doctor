<script setup lang="ts">
import doctorPackage from "../../../../package.json";
import nuxtRulesReport from "../../../public/rules/nuxt.json";
import nitroRulesReport from "../../../public/rules/nitro.json";
import vueRulesReport from "../../../public/rules/vue.json";

type Framework = "vue" | "nuxt" | "nitro";

definePageMeta({
  header: false,
  footer: false,
  layout: false,
  validate: (route) => ["vue", "nuxt", "nitro"].includes(String(route.params.framework)),
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

interface RawRuleEntry {
  id: string;
  title: string;
  description: string;
  pack: string;
  severity: RuleEntry["severity"];
  category: string;
  fixable: RuleEntry["fix"];
  docsUrl: string;
}

interface RulesReport {
  rules: RawRuleEntry[];
}

const route = useRoute();
const framework = computed(() => String(route.params.framework) as Framework);
const search = ref("");
const openRuleIds = ref(new Set<string>());

const META: Record<Framework, { label: string; pack: string; icon: string }> = {
  vue: {
    label: "Vue",
    pack: "vue-doctor",
    icon: "i-logos-vue",
  },
  nuxt: {
    label: "Nuxt",
    pack: "nuxt-doctor",
    icon: "i-logos-nuxt-icon",
  },
  nitro: {
    label: "Nitro",
    pack: "nuxt-doctor/nitro",
    icon: "i-unjs-nitro",
  },
};

const FRAMEWORKS = Object.keys(META) as Framework[];

const meta = computed(() => META[framework.value]);
const ruleReports: Record<Framework, RulesReport> = {
  vue: vueRulesReport as RulesReport,
  nuxt: nuxtRulesReport as RulesReport,
  nitro: nitroRulesReport as RulesReport,
};

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
      href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap",
    },
  ],
}));

const rules = computed<RuleEntry[]>(() =>
  ruleReports[framework.value].rules.map((r) => {
    const fix = r.fixable || "no";
    return {
      path: ruleHref(r, framework.value),
      title: r.title,
      description: r.description,
      ruleId: r.id,
      pack: r.pack,
      severity: r.severity,
      category: r.category,
      fix,
    };
  }),
);

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
  server: "Server",
  shared: "Shared",
  ssr: "SSR safety",
  state: "State",
  style: "Style",
  template: "Template",
  ui: "UI",
  watch: "Watchers",
  watchers: "Watchers",
};

const totalRules = computed(() => rules.value.length);
const sortedRules = computed(() =>
  rules.value.slice().sort((a, b) => {
    const category = categoryLabel(a.category).localeCompare(categoryLabel(b.category));
    if (category) return category;
    return a.ruleId.localeCompare(b.ruleId);
  }),
);
const filteredRules = computed(() => {
  const query = search.value.trim().toLowerCase();
  if (!query) return sortedRules.value;
  return sortedRules.value.filter((rule) =>
    [
      rule.ruleId,
      rule.title,
      rule.description,
      rule.pack,
      rule.category,
      categoryLabel(rule.category),
      rule.severity,
      fixLabel(rule.fix),
    ]
      .join(" ")
      .toLowerCase()
      .includes(query),
  );
});

const ruleStats = computed(() => {
  const items = rules.value;
  return [
    {
      label: "Errors",
      value: items.filter((rule) => rule.severity === "error").length,
      icon: "i-lucide-circle-alert",
      class: "text-rose-600 dark:text-rose-400",
    },
    {
      label: "Warnings",
      value: items.filter((rule) => rule.severity === "warn").length,
      icon: "i-lucide-triangle-alert",
      class: "text-amber-600 dark:text-amber-400",
    },
    {
      label: "Fixes",
      value: items.filter((rule) => rule.fix !== "no").length,
      icon: "i-lucide-wand-sparkles",
      class: "text-emerald-600 dark:text-emerald-400",
    },
    {
      label: "Categories",
      value: new Set(items.map((rule) => rule.category)).size,
      icon: "i-lucide-list-filter",
      class: "text-blue-600 dark:text-blue-400",
    },
  ];
});

const isFiltered = computed(() => search.value.trim().length > 0);
const versionLabel = computed(() => `v${doctorPackage.version}`);

watch(framework, () => {
  search.value = "";
  collapseAll();
});

function categoryLabel(slug: string) {
  return CATEGORY_LABELS[slug] ?? slug.replace(/-/g, " ");
}

function packLabel(pack: string) {
  return pack.replace(/^(nuxt|vue)-doctor\//, "");
}

function ruleHref(rule: RawRuleEntry, currentFramework: Framework) {
  const base =
    rule.pack === "nuxt-doctor/nitro"
      ? "/nitro/rules"
      : rule.pack.startsWith("vue-doctor/")
        ? "/vue/rules"
        : currentFramework === "vue"
          ? "/vue/rules"
          : "/nuxt/rules";
  return `${base}/${ruleDocsPath(rule)}`;
}

function ruleDocsPath(rule: RawRuleEntry) {
  const parts = rule.id.split("/");
  const pathParts =
    parts.length > 2
      ? parts.slice(1)
      : [rule.category || rule.pack.split("/").at(-1) || "rules", parts.at(-1) || rule.id];
  return pathParts.map(slugSegment).join("/");
}

function slugSegment(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function ruleNameParts(ruleId: string) {
  return ruleId.split(/([:/])/g).filter(Boolean);
}

function ruleNamePartClass(part: string, index: number, parts: string[]) {
  if (part === "/" || part === ":") return "text-neutral-400 dark:text-neutral-600";
  if (index === 0) return "text-indigo-600 dark:text-indigo-400";
  if (index < parts.length - 1) return categoryNameClass(part);
  return "text-neutral-800 dark:text-neutral-100";
}

function categoryNameClass(category: string) {
  return (
    {
      auth: "text-purple-600 dark:text-purple-400",
      cache: "text-orange-600 dark:text-orange-400",
      context: "text-violet-600 dark:text-violet-400",
      fetch: "text-sky-600 dark:text-sky-400",
      hydration: "text-cyan-600 dark:text-cyan-400",
      imports: "text-teal-600 dark:text-teal-400",
      request: "text-emerald-600 dark:text-emerald-400",
      runtime: "text-amber-600 dark:text-amber-400",
      security: "text-rose-600 dark:text-rose-400",
      server: "text-emerald-600 dark:text-emerald-400",
      state: "text-blue-600 dark:text-blue-400",
      ui: "text-pink-600 dark:text-pink-400",
    }[category] ?? "text-teal-600 dark:text-teal-400"
  );
}

function severityIcon(severity: RuleEntry["severity"]) {
  return {
    error: "i-lucide-circle-alert",
    warn: "i-lucide-triangle-alert",
    info: "i-lucide-info",
  }[severity];
}

function severityClass(severity: RuleEntry["severity"]) {
  return {
    error: "text-rose-600 dark:text-rose-400",
    warn: "text-amber-600 dark:text-amber-400",
    info: "text-sky-600 dark:text-sky-400",
  }[severity];
}

function severityBadgeColor(severity: RuleEntry["severity"]) {
  return {
    error: "error",
    warn: "warning",
    info: "info",
  }[severity] as "error" | "warning" | "info";
}

function fixLabel(fix: RuleEntry["fix"]) {
  if (fix === "safe") return "Auto-fix";
  if (fix === "suggestion") return "Suggestion";
  return "No fix";
}

function fixIcon(fix: RuleEntry["fix"]) {
  if (fix === "safe") return "i-lucide-wand-sparkles";
  if (fix === "suggestion") return "i-lucide-plug";
  return "i-lucide-plug-zap";
}

function fixClass(fix: RuleEntry["fix"]) {
  if (fix === "safe") return "text-emerald-600 dark:text-emerald-400";
  if (fix === "suggestion") return "text-teal-600 dark:text-teal-400";
  return "text-neutral-300 dark:text-neutral-700";
}

function fixBadgeColor(fix: RuleEntry["fix"]) {
  if (fix === "safe") return "success";
  if (fix === "suggestion") return "primary";
  return "neutral";
}

function isRuleOpen(ruleId: string) {
  return openRuleIds.value.has(ruleId);
}

function setRuleOpen(ruleId: string, open: boolean) {
  const next = new Set(openRuleIds.value);
  if (open) next.add(ruleId);
  else next.delete(ruleId);
  openRuleIds.value = next;
}

function handleToggle(ruleId: string, event: Event) {
  setRuleOpen(ruleId, (event.currentTarget as HTMLDetailsElement).open);
}

function expandAll() {
  openRuleIds.value = new Set(filteredRules.value.map((rule) => rule.ruleId));
}

function collapseAll() {
  openRuleIds.value = new Set();
}

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
      <header class="py-2">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <a
            href="/"
            class="inline-flex items-center gap-2 rounded-md text-3xl font-light tracking-tight text-neutral-800 hover:text-neutral-950 dark:text-neutral-100 dark:hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
            aria-label="Doctor home"
          >
            <span
              class="inline-flex size-7 items-center justify-center rounded-md bg-primary-600 text-white ring-1 ring-primary-700/20 dark:bg-primary-500"
              aria-hidden="true"
            >
              <UIcon name="i-lucide-stethoscope" class="size-4" />
            </span>
            <h1>{{ meta.label }} Doctor rules</h1>
          </a>
          <span class="-translate-y-2 font-mono text-sm text-neutral-500 dark:text-neutral-500">
            {{ versionLabel }}
          </span>
        </div>

        <div
          class="mt-2 flex flex-wrap items-center gap-1 text-sm text-neutral-600 dark:text-neutral-400"
        >
          <span>Composed with</span>
          <strong class="font-semibold text-neutral-900 dark:text-neutral-100">{{
            totalRules
          }}</strong>
          <span>rule items from</span>
          <code class="font-mono text-neutral-800 dark:text-neutral-200">{{ meta.pack }}</code>
        </div>

        <nav class="mt-4 flex flex-wrap items-center gap-3" aria-label="Rule sets">
          <UButton
            v-for="fw in FRAMEWORKS"
            :key="fw"
            :to="`/rules/${fw}`"
            :color="framework === fw ? 'primary' : 'neutral'"
            :variant="framework === fw ? 'soft' : 'outline'"
            size="sm"
            class="rounded-md"
          >
            <UIcon :name="META[fw].icon" class="size-4 shrink-0" aria-hidden="true" />
            {{ META[fw].label }}
          </UButton>

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
        </nav>
      </header>

      <section class="mt-7 grid gap-3">
        <UInput
          v-model="search"
          name="rules-search"
          :placeholder="`Search ${meta.label} rule IDs, categories, or descriptions...`"
          icon="i-lucide-search"
          size="xl"
          variant="outline"
          class="w-full"
        />

        <div class="flex flex-wrap items-center gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <span
              class="inline-flex items-center gap-2 rounded-full border border-neutral-950/10 bg-neutral-950/5 px-3 py-1 text-sm text-neutral-700 dark:border-white/10 dark:bg-white/5 dark:text-neutral-300"
            >
              <UIcon name="i-lucide-list-checks" class="size-4" aria-hidden="true" />
              <span class="font-semibold tabular-nums">{{ filteredRules.length }}</span>
              <span>{{ isFiltered ? "rules filtered" : "rules enabled" }}</span>
              <span class="text-neutral-500 dark:text-neutral-500"
                >out of {{ totalRules }} rules</span
              >
            </span>

            <span
              v-for="stat in ruleStats"
              :key="stat.label"
              class="inline-flex items-center gap-1.5 rounded-full border border-neutral-950/10 px-3 py-1 text-sm text-neutral-600 dark:border-white/10 dark:text-neutral-400"
            >
              <UIcon :name="stat.icon" class="size-4" :class="stat.class" aria-hidden="true" />
              <span class="font-semibold tabular-nums text-neutral-800 dark:text-neutral-200">
                {{ stat.value }}
              </span>
              <span>{{ stat.label.toLowerCase() }}</span>
            </span>
          </div>

          <div class="flex-auto" />

          <UButton
            color="neutral"
            variant="outline"
            size="sm"
            class="rounded-md"
            @click="expandAll"
          >
            Expand All
          </UButton>
          <UButton
            color="neutral"
            variant="outline"
            size="sm"
            class="rounded-md"
            @click="collapseAll"
          >
            Collapse All
          </UButton>
        </div>
      </section>

      <section class="mt-3">
        <p
          v-if="!filteredRules.length"
          class="py-8 text-sm text-neutral-500 italic dark:text-neutral-500"
        >
          No matched rule items.
        </p>

        <ol v-else role="list" class="grid gap-3 pt-2">
          <li v-for="(rule, index) in filteredRules" :key="rule.ruleId" class="relative sm:pl-10">
            <span
              class="absolute top-2 right-[calc(100%-1.75rem)] hidden w-8 text-right font-mono text-base text-neutral-400 tabular-nums sm:block dark:text-neutral-600"
            >
              #{{ index + 1 }}
            </span>

            <details
              class="group relative rounded-lg border border-neutral-950/10 bg-neutral-50/70 dark:border-white/10 dark:bg-white/[0.03]"
              :open="isRuleOpen(rule.ruleId)"
              @toggle="handleToggle(rule.ruleId, $event)"
            >
              <summary
                class="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 font-mono text-sm select-none [&::-webkit-details-marker]:hidden"
              >
                <div class="flex min-w-0 items-center gap-2">
                  <span
                    class="font-mono text-neutral-400 tabular-nums sm:hidden dark:text-neutral-600"
                  >
                    #{{ index + 1 }}
                  </span>
                  <UIcon
                    name="i-lucide-chevron-right"
                    class="size-4 shrink-0 text-neutral-400 transition group-open:rotate-90 dark:text-neutral-600"
                    aria-hidden="true"
                  />
                  <a
                    :href="rule.path"
                    class="min-w-0 truncate rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
                    @click.stop
                  >
                    <span
                      v-for="(part, partIndex) in ruleNameParts(rule.ruleId)"
                      :key="`${rule.ruleId}-${partIndex}`"
                      :class="ruleNamePartClass(part, partIndex, ruleNameParts(rule.ruleId))"
                    >
                      {{ part }}
                    </span>
                  </a>
                </div>

                <div class="flex items-center gap-3 text-sm">
                  <UTooltip :text="categoryLabel(rule.category)">
                    <span
                      class="inline-flex items-center gap-1 text-neutral-300 dark:text-neutral-700"
                    >
                      <UIcon name="i-lucide-file-search" class="size-4" aria-hidden="true" />
                    </span>
                  </UTooltip>
                  <UTooltip :text="rule.severity">
                    <span
                      class="inline-flex items-center gap-1"
                      :class="severityClass(rule.severity)"
                    >
                      <UIcon
                        :name="severityIcon(rule.severity)"
                        class="size-4"
                        aria-hidden="true"
                      />
                      <span class="hidden font-mono tabular-nums sm:inline">{{
                        rule.severity
                      }}</span>
                    </span>
                  </UTooltip>
                  <UTooltip :text="fixLabel(rule.fix)">
                    <span class="inline-flex items-center gap-1" :class="fixClass(rule.fix)">
                      <UIcon :name="fixIcon(rule.fix)" class="size-4" aria-hidden="true" />
                      <span v-if="rule.fix !== 'no'" class="hidden font-mono tabular-nums sm:inline"
                        >1</span
                      >
                    </span>
                  </UTooltip>
                  <UTooltip :text="packLabel(rule.pack)">
                    <span
                      class="hidden items-center gap-1 text-blue-500 sm:inline-flex dark:text-blue-400"
                    >
                      <UIcon name="i-lucide-list" class="size-4" aria-hidden="true" />
                    </span>
                  </UTooltip>
                </div>
              </summary>

              <div class="border-t border-neutral-950/10 px-4 py-4 dark:border-white/10">
                <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
                  <div class="min-w-0">
                    <p
                      class="max-w-[80ch] text-base text-pretty text-neutral-700 dark:text-neutral-300"
                    >
                      {{ rule.description }}
                    </p>
                    <div class="mt-3 flex flex-wrap items-center gap-2">
                      <UBadge color="neutral" variant="soft" class="rounded-md font-mono">
                        {{ categoryLabel(rule.category) }}
                      </UBadge>
                      <UBadge
                        :color="severityBadgeColor(rule.severity)"
                        variant="soft"
                        class="rounded-md font-mono"
                      >
                        {{ rule.severity }}
                      </UBadge>
                      <UBadge
                        :color="fixBadgeColor(rule.fix)"
                        variant="soft"
                        class="rounded-md font-mono"
                      >
                        {{ fixLabel(rule.fix) }}
                      </UBadge>
                      <UBadge color="neutral" variant="outline" class="rounded-md font-mono">
                        {{ packLabel(rule.pack) }}
                      </UBadge>
                    </div>
                  </div>

                  <div class="flex items-start gap-2">
                    <UButton
                      :to="rule.path"
                      color="neutral"
                      variant="outline"
                      size="sm"
                      class="rounded-md"
                      trailing-icon="i-lucide-arrow-up-right"
                    >
                      Open rule
                    </UButton>
                  </div>
                </div>
              </div>
            </details>
          </li>
        </ol>
      </section>
    </main>
  </div>
</template>
