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

const frameworkNavigationOrder = ["nuxt", "vue", "nitro", "vite"] as const satisfies Framework[];

export function createRulesNavigation(
  rules: RuleNavigationEntry[],
  diagnostics: DiagnosticNavigationEntry[] = [],
): ContentNavigationItem {
  const diagnosticCodeByRuleId = new Map(
    diagnostics.map((diagnostic) => [diagnostic.ruleId, diagnostic.code]),
  );
  const children = frameworkNavigationOrder.flatMap((framework) => {
    const meta = FRAMEWORK_META[framework];
    const frameworkRules = rules
      .filter((rule) => ruleFramework(rule) === framework)
      .toSorted(compareRules);

    return [
      {
        title: `${meta.label} rules`,
        path: `/rules/${framework}`,
        icon: meta.icon,
        badge: frameworkRules.length,
      },
      ...frameworkRules.map((rule) => ({
        title: diagnosticCodeByRuleId.get(rule.ruleId) || rule.ruleId,
        path: rule.path,
        ruleId: rule.ruleId,
      })),
    ];
  });

  return {
    title: "Rules",
    path: "/rules/nuxt",
    icon: "i-lucide-list-checks",
    children,
  };
}

export function appendRulesNavigation(
  navigation: ContentNavigationItem[],
  rulesNavigation: ContentNavigationItem,
): ContentNavigationItem[] {
  if (navigation.some((item) => item.path === rulesNavigation.path)) return navigation;
  return [...navigation, rulesNavigation];
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
