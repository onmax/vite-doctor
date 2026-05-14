<script setup lang="ts">
import { useRuleExplorer } from "../composables/useRuleExplorer";
import type { RawRuleEntry } from "../utils/rule-catalog";
import {
  categoryLabel,
  fixClass,
  fixIcon,
  fixLabel,
  packLabel,
  ruleNamePartClass,
  ruleNameParts,
  severityClass,
  severityIcon,
  FRAMEWORK_META,
  type FrameworkFilter,
} from "../utils/rule-metadata";

const props = withDefaults(
  defineProps<{
    rules: RawRuleEntry[];
    title: string;
    description?: string;
    currentFramework?: FrameworkFilter;
    packLabel?: string;
    frameworkTabsMode?: "filter" | "links";
    headingTag?: "h1" | "h2";
  }>(),
  {
    description: "",
    currentFramework: "all",
    packLabel: "",
    frameworkTabsMode: "filter",
    headingTag: "h2",
  },
);

const runtimeConfig = useRuntimeConfig();
const versionLabel = computed(() => `v${runtimeConfig.public.doctorVersion}`);
const filterFieldUi = {
  root: "min-w-0",
  label: "text-xs font-medium text-neutral-500 dark:text-neutral-500",
  container: "mt-1",
};
const filterControlUi = {
  base: "h-9 rounded-md text-sm",
  content: "min-w-(--reka-select-trigger-width)",
};
const fixItems = [
  { value: "all", label: "All fixes", icon: "i-lucide-list-filter" },
  { value: "safe", label: "Auto-fix", icon: fixIcon("safe") },
  { value: "suggestion", label: "Suggestion", icon: fixIcon("suggestion") },
  { value: "no", label: "No fix", icon: fixIcon("no") },
] as const;
const {
  search,
  frameworkFilter,
  categoryFilter,
  severityFilter,
  fixFilter,
  frameworkRules,
  frameworkTabs,
  categoryOptions,
  filteredRules,
  isFiltered,
  ruleStats,
  resetFilters,
  isRuleOpen,
  handleToggle,
} = useRuleExplorer({
  rules: () => props.rules,
  currentFramework: () => props.currentFramework,
  frameworkTabsMode: () => props.frameworkTabsMode,
});
const frameworkItems = computed(() =>
  frameworkTabs.value.map((tab) => ({
    value: tab.id,
    label: tab.label,
    icon: tab.icon,
    description: `${tab.count} rules`,
  })),
);
const selectedFrameworkItem = computed(
  () =>
    frameworkItems.value.find((item) => item.value === frameworkFilter.value) ??
    frameworkItems.value[0],
);
const severityItems = computed(() => [
  {
    value: "all",
    label: "All severities",
    icon: "i-lucide-list-checks",
    class: "text-neutral-500 dark:text-neutral-500",
    count: frameworkRules.value.length,
  },
  {
    value: "error",
    label: "Error",
    icon: severityIcon("error"),
    class: severityClass("error"),
    count: frameworkRules.value.filter((rule) => rule.severity === "error").length,
  },
  {
    value: "warn",
    label: "Warning",
    icon: severityIcon("warn"),
    class: severityClass("warn"),
    count: frameworkRules.value.filter((rule) => rule.severity === "warn").length,
  },
  {
    value: "info",
    label: "Info",
    icon: severityIcon("info"),
    class: severityClass("info"),
    count: frameworkRules.value.filter((rule) => rule.severity === "info").length,
  },
]);
const selectedSeverityItem = computed(
  () =>
    severityItems.value.find((item) => item.value === severityFilter.value) ??
    severityItems.value[0],
);
const severitySelectLabel = computed(() => {
  const item = selectedSeverityItem.value;
  if (!item) return "";
  return `${item.count} ${item.label}`;
});
const categoryItems = computed(() => [
  {
    value: "all",
    label: "All categories",
    icon: "i-lucide-list-filter",
    description: `${frameworkRules.value.length} rules`,
  },
  ...categoryOptions.value.map((category) => ({
    ...category,
    icon: "i-lucide-folder",
    description: `${frameworkRules.value.filter((rule) => rule.category === category.value).length} rules`,
  })),
]);
const frameworkLinkOrder = ["nuxt", "vue", "nitro", "vite"] as const;
const frameworkLinkTabs = computed(() =>
  frameworkLinkOrder.map((framework) => ({
    id: framework,
    label: FRAMEWORK_META[framework].label,
    icon: FRAMEWORK_META[framework].icon,
    activeClass: {
      nuxt: "bg-emerald-500/14 text-emerald-700 ring-emerald-500/20 dark:bg-emerald-400/16 dark:text-emerald-300 dark:ring-emerald-400/20",
      vue: "bg-green-500/14 text-green-700 ring-green-500/20 dark:bg-green-400/16 dark:text-green-300 dark:ring-green-400/20",
      nitro:
        "bg-fuchsia-500/14 text-fuchsia-700 ring-fuchsia-500/20 dark:bg-fuchsia-400/16 dark:text-fuchsia-300 dark:ring-fuchsia-400/20",
      vite: "bg-amber-400/18 text-amber-700 ring-amber-500/20 dark:bg-amber-300/16 dark:text-amber-300 dark:ring-amber-300/20",
    }[framework],
  })),
);
const activeFrameworkLinkId = ref<FrameworkFilter>(props.currentFramework);
watch(
  () => props.currentFramework,
  (framework) => {
    activeFrameworkLinkId.value = framework;
  },
);
const activeFrameworkLinkIndex = computed(() =>
  Math.max(
    0,
    frameworkLinkTabs.value.findIndex((tab) => tab.id === activeFrameworkLinkId.value),
  ),
);
const activeFrameworkLinkClass = computed(
  () =>
    frameworkLinkTabs.value.find((tab) => tab.id === activeFrameworkLinkId.value)?.activeClass ??
    frameworkLinkTabs.value[0]?.activeClass,
);
</script>

<template>
  <section class="rule-explorer w-full">
    <header class="py-2">
      <div class="flex flex-col gap-2 md:flex-row md:items-baseline md:justify-between">
        <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <a
            href="/"
            class="inline-flex items-center gap-2 rounded-md text-neutral-800 hover:text-neutral-950 dark:text-neutral-100 dark:hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
            aria-label="Doctor home"
          >
            <span
              class="inline-flex size-7 items-center justify-center self-center rounded-md bg-primary-600 text-white ring-1 ring-primary-700/20 dark:bg-primary-500"
              aria-hidden="true"
            >
              <UIcon name="i-lucide-stethoscope" class="size-4" />
            </span>
            <component :is="headingTag" class="text-3xl font-light tracking-tight text-inherit">
              {{ title }}
              <span
                class="ml-2 align-baseline font-mono text-sm text-neutral-500 dark:text-neutral-500"
              >
                {{ versionLabel }}
              </span>
            </component>
          </a>
        </div>

        <p
          class="text-xs font-medium text-neutral-500 md:ml-auto md:text-right dark:text-neutral-500"
        >
          Design inspired by
          <ULink
            to="https://github.com/antfu/eslint-config"
            target="_blank"
            rel="noopener"
            class="inline-flex items-center gap-1 underline decoration-neutral-300 underline-offset-4 hover:text-neutral-900 hover:decoration-neutral-900 dark:decoration-neutral-700 dark:hover:text-neutral-100 dark:hover:decoration-neutral-100"
          >
            Antfu ESLint Config
            <UIcon name="i-lucide-arrow-up-right" class="size-3" aria-hidden="true" />
          </ULink>
        </p>
      </div>

      <p
        v-if="description"
        class="mt-3 max-w-3xl text-base text-pretty text-neutral-600 dark:text-neutral-400"
      >
        {{ description }}
      </p>

      <nav v-if="frameworkTabsMode === 'links'" class="mt-5 w-full max-w-xl" aria-label="Rule sets">
        <div
          class="relative grid grid-cols-4 gap-1 rounded-full bg-neutral-100/80 p-1 text-sm ring-1 ring-neutral-200/80 dark:bg-neutral-900/80 dark:ring-white/10"
          role="tablist"
          aria-label="Rule framework"
        >
          <span
            class="pointer-events-none absolute top-1 bottom-1 left-1 w-[calc((100%_-_1.25rem)/4)] rounded-full shadow-sm ring-1 transition-[transform,background-color,color,box-shadow] duration-[420ms] ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
            :class="activeFrameworkLinkClass"
            :style="{
              transform: `translateX(calc(${activeFrameworkLinkIndex} * (100% + 0.25rem)))`,
            }"
            aria-hidden="true"
          />
          <NuxtLink
            v-for="tab in frameworkLinkTabs"
            :key="tab.id"
            :to="`/rules/${tab.id}`"
            prefetch
            role="tab"
            :aria-selected="activeFrameworkLinkId === tab.id"
            class="relative z-10 inline-flex min-w-0 items-center justify-center gap-1.5 rounded-full px-2.5 py-1.5 font-medium transition-[color,transform] duration-150 active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500 sm:px-3"
            :class="
              activeFrameworkLinkId === tab.id
                ? 'text-neutral-950 dark:text-neutral-50'
                : 'text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100'
            "
            @click="activeFrameworkLinkId = tab.id"
          >
            <UIcon :name="tab.icon" class="size-4 shrink-0" aria-hidden="true" />
            <span class="truncate">{{ tab.label }}</span>
          </NuxtLink>
        </div>
      </nav>
    </header>

    <div class="mt-7 flex flex-wrap items-end gap-2 lg:flex-nowrap">
      <div class="min-w-72 flex-1 basis-0">
        <UInput
          v-model="search"
          name="rules-search"
          :placeholder="`Search ${title} rule IDs, categories, or descriptions...`"
          icon="i-lucide-search"
          size="md"
          variant="outline"
          class="w-full"
          :ui="{
            base: 'h-9 rounded-md py-0 text-sm',
            leading: 'ps-2.5',
            leadingIcon: 'size-4 text-neutral-400 dark:text-neutral-500',
            trailing: 'pe-2.5',
            root: 'text-sm',
            input: 'py-0',
          }"
        />
      </div>

      <div class="min-w-0 shrink-0">
        <div class="flex flex-wrap items-end gap-2">
          <div
            class="inline-flex h-9 items-center gap-2 rounded-md bg-neutral-100/80 px-3 text-sm text-neutral-700 ring ring-inset ring-neutral-950/10 dark:bg-white/[0.04] dark:text-neutral-300 dark:ring-white/10"
          >
            <UIcon
              name="i-lucide-list-checks"
              class="size-4 shrink-0 text-neutral-400 dark:text-neutral-600"
              aria-hidden="true"
            />
            <span class="tabular-nums">
              <span class="font-semibold text-neutral-900 dark:text-neutral-100">{{
                filteredRules.length
              }}</span>
              {{ isFiltered ? "filtered" : "visible" }}
              <span
                v-if="filteredRules.length !== frameworkRules.length"
                class="text-neutral-400 dark:text-neutral-600"
              >
                / {{ frameworkRules.length }}
              </span>
            </span>
          </div>

          <UFormField
            v-if="frameworkTabsMode === 'filter'"
            label="Framework"
            name="rule-framework"
            size="sm"
            :ui="filterFieldUi"
          >
            <USelect
              v-model="frameworkFilter"
              name="rule-framework"
              :items="frameworkItems"
              color="neutral"
              variant="outline"
              size="sm"
              class="w-40"
              :ui="filterControlUi"
            >
              <template #leading>
                <UIcon
                  :name="selectedFrameworkItem?.icon ?? 'i-lucide-list-checks'"
                  class="size-4 shrink-0"
                  aria-hidden="true"
                />
              </template>
            </USelect>
          </UFormField>

          <UFormField label="Category" name="rule-category" size="sm" :ui="filterFieldUi">
            <USelectMenu
              v-model="categoryFilter"
              name="rule-category"
              value-key="value"
              label-key="label"
              :items="categoryItems"
              :search-input="{ placeholder: 'Search categories...', icon: 'i-lucide-search' }"
              :content="{ align: 'start', sideOffset: 6 }"
              color="neutral"
              variant="outline"
              size="sm"
              class="w-48"
              :ui="filterControlUi"
            />
          </UFormField>

          <UFormField label="Severity" name="rule-severity" size="sm" :ui="filterFieldUi">
            <USelect
              v-model="severityFilter"
              name="rule-severity"
              :items="severityItems"
              color="neutral"
              variant="outline"
              size="sm"
              class="w-48"
              :ui="filterControlUi"
            >
              <template #default>
                <span class="flex min-w-0 items-center gap-2">
                  <span class="shrink-0 font-semibold tabular-nums">
                    {{ selectedSeverityItem?.count }}
                  </span>
                  <UIcon
                    :name="selectedSeverityItem?.icon ?? 'i-lucide-list-checks'"
                    class="size-4 shrink-0"
                    :class="selectedSeverityItem?.class"
                    aria-hidden="true"
                  />
                  <span class="min-w-0 truncate">{{ selectedSeverityItem?.label }}</span>
                </span>
                <span class="sr-only">{{ severitySelectLabel }}</span>
              </template>
              <template #item-leading="{ item }">
                <span
                  class="min-w-6 text-right font-semibold tabular-nums text-neutral-800 dark:text-neutral-200"
                >
                  {{ item.count }}
                </span>
                <UIcon
                  :name="item.icon"
                  class="size-4 shrink-0"
                  :class="item.class"
                  aria-hidden="true"
                />
              </template>
            </USelect>
          </UFormField>

          <UFormField label="Fix" name="rule-fix" size="sm" :ui="filterFieldUi">
            <USelect
              v-model="fixFilter"
              name="rule-fix"
              :items="fixItems"
              color="neutral"
              variant="outline"
              size="sm"
              class="w-36"
              :ui="filterControlUi"
            />
          </UFormField>

          <UButton
            v-if="isFiltered"
            color="neutral"
            variant="ghost"
            size="sm"
            class="h-9 rounded-md"
            @click="resetFilters"
          >
            Reset
          </UButton>
        </div>
      </div>
    </div>

    <div class="mt-3">
      <p
        v-if="!filteredRules.length"
        class="py-8 text-sm text-neutral-500 italic dark:text-neutral-500"
      >
        No matched rule items.
      </p>

      <ol v-else role="list" class="grid gap-3 pt-2">
        <li v-for="(rule, index) in filteredRules" :key="rule.ruleId" class="relative">
          <UCard
            variant="subtle"
            class="overflow-hidden"
            :ui="{ root: 'rounded-lg', body: 'p-0 sm:p-0' }"
          >
            <details
              class="group relative"
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
                    :href="rule.docsPath"
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
                <RuleExpandedContent v-if="isRuleOpen(rule.ruleId)" :path="rule.docsPath" />
                <div class="mt-4 flex justify-end">
                  <UButton
                    :to="rule.docsPath"
                    color="neutral"
                    variant="outline"
                    size="sm"
                    class="rounded-md"
                    trailing-icon="i-lucide-arrow-up-right"
                  >
                    Open full page
                  </UButton>
                </div>
              </div>
            </details>
          </UCard>
        </li>
      </ol>
    </div>
  </section>
</template>
