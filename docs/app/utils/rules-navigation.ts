import type { ContentNavigationItem } from "@nuxt/content";
import { FRAMEWORK_META, frameworkOfPack, type Framework } from "./rule-metadata.js";

type RuleNavigationEntry = {
  path: string;
  title: string;
  ruleId: string;
  category: string;
  framework?: Framework;
  pack?: string;
};

type DiagnosticNavigationEntry = {
  code: string;
  ruleId: string;
};

const frameworkNavigationOrder = [
  "typescript",
  "nuxt",
  "vue",
  "vite",
  "nitro",
] as const satisfies Framework[];

export function createRulesNavigation(
  rules: RuleNavigationEntry[],
  diagnostics: DiagnosticNavigationEntry[] = [],
): ContentNavigationItem[] {
  const diagnosticCodeByRuleId = new Map(
    diagnostics.map((diagnostic) => [diagnostic.ruleId, diagnostic.code]),
  );
  return frameworkNavigationOrder.map((framework) => {
    const meta = FRAMEWORK_META[framework];
    const frameworkRules = rules
      .filter((rule) => ruleFramework(rule) === framework)
      .toSorted(compareRules);

    return {
      title: meta.label,
      path: `/${framework}`,
      icon: meta.icon,
      children: [
        {
          title: "Installation",
          path: `/${framework}`,
          icon: "i-lucide-book-open",
        },
        {
          title: `${meta.label} rules`,
          path: `/${framework}/rules`,
          icon: "i-lucide-list-checks",
          badge: frameworkRules.length,
        },
        ...frameworkRules.map((rule) => ({
          title: diagnosticCodeByRuleId.get(rule.ruleId) || rule.ruleId,
          path: rule.path,
          ruleId: rule.ruleId,
        })),
      ],
    };
  });
}

export function appendRulesNavigation(
  navigation: ContentNavigationItem[],
  rulesNavigation: ContentNavigationItem[],
): ContentNavigationItem[] {
  const existingPaths = new Set(navigation.map((item) => item.path));
  const rulesByPath = new Map(rulesNavigation.map((item) => [item.path, item]));
  const merged = navigation.map((item) => {
    const rulesItem = item.path ? rulesByPath.get(item.path) : undefined;
    if (!rulesItem) return item;
    return {
      ...rulesItem,
      ...item,
      icon: item.icon ?? rulesItem.icon,
      children: mergeChildren(item.children ?? [], rulesItem.children ?? []),
    };
  });
  return [...merged, ...rulesNavigation.filter((item) => !existingPaths.has(item.path))];
}

function compareRules(left: RuleNavigationEntry, right: RuleNavigationEntry) {
  return (
    left.category.localeCompare(right.category) ||
    left.ruleId.localeCompare(right.ruleId) ||
    left.title.localeCompare(right.title)
  );
}

function ruleFramework(rule: RuleNavigationEntry): Framework {
  return rule.framework ?? frameworkOfPack(rule.pack ?? "");
}

function mergeChildren(
  existing: ContentNavigationItem[],
  generated: ContentNavigationItem[],
): ContentNavigationItem[] {
  const existingPaths = new Set(existing.map((item) => item.path));
  return [...existing, ...generated.filter((item) => !existingPaths.has(item.path))];
}
