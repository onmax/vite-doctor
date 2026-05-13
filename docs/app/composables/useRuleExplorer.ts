import { computed, ref, toValue, watch, type MaybeRefOrGetter } from "vue";
import {
  normalizeCatalogRules,
  type CatalogRule,
  type RawRuleEntry,
} from "../utils/rule-catalog.js";
import {
  categoryLabel,
  FRAMEWORKS,
  FRAMEWORK_META,
  type FixKind,
  type FrameworkFilter,
  type Severity,
} from "../utils/rule-metadata.js";

export function useRuleExplorer(options: {
  rules: MaybeRefOrGetter<RawRuleEntry[]>;
  currentFramework: MaybeRefOrGetter<FrameworkFilter>;
  frameworkTabsMode: MaybeRefOrGetter<"filter" | "links">;
}) {
  const search = ref("");
  const frameworkFilter = ref<FrameworkFilter>(toValue(options.currentFramework));
  const categoryFilter = ref("all");
  const severityFilter = ref<Severity | "all">("all");
  const fixFilter = ref<FixKind | "all">("all");
  const openRuleIds = ref(new Set<string>());

  const rules = computed<CatalogRule[]>(() =>
    normalizeCatalogRules(toValue(options.rules), toValue(options.currentFramework)),
  );

  watch(
    () => toValue(options.currentFramework),
    (framework) => {
      frameworkFilter.value = framework;
      resetFilters();
    },
  );

  const availableFrameworks = computed(() =>
    FRAMEWORKS.filter((framework) => rules.value.some((rule) => rule.framework === framework)),
  );

  const frameworkTabs = computed(() => {
    const tabs: Array<{ id: FrameworkFilter; label: string; icon: string; count: number }> = [];
    if (toValue(options.frameworkTabsMode) === "filter") {
      tabs.push({
        id: "all",
        label: "All",
        icon: "i-lucide-list-checks",
        count: rules.value.length,
      });
    }
    for (const framework of availableFrameworks.value) {
      tabs.push({
        id: framework,
        label: FRAMEWORK_META[framework].label,
        icon: FRAMEWORK_META[framework].icon,
        count: rules.value.filter((rule) => rule.framework === framework).length,
      });
    }
    return tabs;
  });

  const frameworkRules = computed(() => {
    if (toValue(options.frameworkTabsMode) === "links") return rules.value;
    if (frameworkFilter.value === "all") return rules.value;
    return rules.value.filter((rule) => rule.framework === frameworkFilter.value);
  });

  const categoryOptions = computed(() =>
    [...new Set(frameworkRules.value.map((rule) => rule.category))]
      .sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b)))
      .map((category) => ({ value: category, label: categoryLabel(category) })),
  );

  const sortedRules = computed(() =>
    frameworkRules.value.slice().sort((a, b) => {
      const category = categoryLabel(a.category).localeCompare(categoryLabel(b.category));
      if (category) return category;
      return a.ruleId.localeCompare(b.ruleId);
    }),
  );

  const filteredRules = computed(() => {
    const query = search.value.trim().toLowerCase();
    return sortedRules.value.filter((rule) => {
      if (categoryFilter.value !== "all" && rule.category !== categoryFilter.value) return false;
      if (severityFilter.value !== "all" && rule.severity !== severityFilter.value) return false;
      if (fixFilter.value !== "all" && rule.fix !== fixFilter.value) return false;
      return !query || rule.searchText.includes(query);
    });
  });

  const totalRules = computed(() => rules.value.length);
  const isFiltered = computed(
    () =>
      search.value.trim().length > 0 ||
      categoryFilter.value !== "all" ||
      severityFilter.value !== "all" ||
      fixFilter.value !== "all" ||
      (toValue(options.frameworkTabsMode) === "filter" && frameworkFilter.value !== "all"),
  );

  const ruleStats = computed(() => {
    const items = frameworkRules.value;
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

  function resetFilters() {
    search.value = "";
    categoryFilter.value = "all";
    severityFilter.value = "all";
    fixFilter.value = "all";
    collapseAll();
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

  return {
    search,
    frameworkFilter,
    categoryFilter,
    severityFilter,
    fixFilter,
    rules,
    frameworkRules,
    frameworkTabs,
    categoryOptions,
    filteredRules,
    totalRules,
    isFiltered,
    ruleStats,
    resetFilters,
    isRuleOpen,
    handleToggle,
    expandAll,
    collapseAll,
  };
}
