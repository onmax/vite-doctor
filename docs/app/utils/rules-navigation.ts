import type { ContentNavigationItem } from "@nuxt/content";
import { categoryLabel, FRAMEWORK_META, frameworkOfPack, type Framework } from "./rule-metadata.js";

export type RuleNavigationEntry = {
  path: string;
  title: string;
  navigation?: boolean | { title?: string };
  ruleId: string;
  category: string;
  framework?: Framework;
  pack?: string;
};

export type DiagnosticNavigationEntry = {
  code: string;
  ruleId: string;
  path?: string;
  framework?: Framework;
};

export interface RulesNavigationOptions {
  activePath?: string;
  includeDiagnostics?: boolean;
  /** Search results read without the sidebar's group context, so they keep full page titles. */
  ruleTitles?: "navigation" | "page";
}

const frameworkNavigationOrder = [
  "typescript",
  "nuxt",
  "vue",
  "vite",
  "nitro",
  "pinia",
  "package",
] as const satisfies Framework[];

export function createRulesNavigation(
  rules: RuleNavigationEntry[],
  diagnostics: DiagnosticNavigationEntry[] = [],
  options: RulesNavigationOptions = {},
): ContentNavigationItem[] {
  const activePath = options.activePath ?? "";
  const ruleTitles = options.ruleTitles ?? "navigation";
  const frameworkOfRule = new Map(rules.map((rule) => [rule.ruleId, ruleFramework(rule)]));

  return frameworkNavigationOrder.map((framework) => {
    const meta = FRAMEWORK_META[framework];
    const rulesPath = `/${framework}/rules`;
    const frameworkRules = rules.filter((rule) => ruleFramework(rule) === framework);
    const categories = groupRulesByCategory(frameworkRules).map(([category, items]) => {
      const categoryPath = `${rulesPath}/${category}`;
      return {
        title: categoryLabel(category),
        path: rulesPath,
        defaultOpen: isWithin(activePath, categoryPath),
        children: items.map((rule) => ({
          title: ruleTitles === "navigation" ? ruleNavigationTitle(rule) : rule.title,
          path: rule.path,
          pageTitle: rule.title,
        })),
      };
    });
    const children: ContentNavigationItem[] = [
      { title: "Installation", path: `/${framework}`, icon: "i-lucide-book-open" },
      {
        title: `${meta.label} rules`,
        path: rulesPath,
        icon: "i-lucide-list-checks",
        badge: frameworkRules.length,
      },
      ...categories,
    ];

    if (options.includeDiagnostics) {
      const frameworkDiagnostics = diagnostics
        .filter(
          (diagnostic) =>
            (diagnostic.framework ?? frameworkOfRule.get(diagnostic.ruleId)) === framework,
        )
        .toSorted((left, right) => left.code.localeCompare(right.code));
      if (frameworkDiagnostics.length) {
        children.push({
          title: "Diagnostic codes",
          path: `/${framework}/diagnostics`,
          defaultOpen: false,
          children: frameworkDiagnostics.map((diagnostic) => ({
            title: diagnostic.code,
            path: diagnostic.path ?? `/diagnostics/${diagnostic.code}`,
          })),
        });
      }
    }

    return {
      title: meta.label,
      path: `/${framework}`,
      icon: meta.icon,
      defaultOpen: isWithin(activePath, `/${framework}`),
      children,
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

// Nuxt UI search only indexes files reachable through navigation leaves, and it
// turns every top-level item into a result group. Standalone pages such as /cli
// need a group of their own so they stay searchable next to the framework groups.
export function groupSearchNavigation(
  navigation: ContentNavigationItem[],
  label = "Docs",
): ContentNavigationItem[] {
  const pages = navigation.filter((item) => !item.children?.length);
  const groups = navigation.filter((item) => item.children?.length);
  if (!pages.length) return groups;
  return [{ title: label, path: "/", children: pages }, ...groups];
}

// The sidebar shows diagnostics as their owning rule, so a diagnostic URL
// resolves to that rule path when deciding which groups start open.
export function resolveRulesActivePath(
  routePath: string,
  rules: Pick<RuleNavigationEntry, "path" | "ruleId">[],
  diagnostics: Pick<DiagnosticNavigationEntry, "code" | "ruleId">[],
) {
  const code = routePath.match(/^\/diagnostics\/([^/]+)$/)?.[1];
  if (!code) return routePath;
  const ruleId = diagnostics.find((diagnostic) => diagnostic.code === code)?.ruleId;
  return rules.find((rule) => rule.ruleId === ruleId)?.path ?? routePath;
}

export function rulesNavigationGroupKey(activePath: string) {
  return activePath.split("/").slice(0, 4).join("/");
}

function groupRulesByCategory(rules: RuleNavigationEntry[]) {
  const groups = new Map<string, RuleNavigationEntry[]>();
  for (const rule of rules) {
    const items = groups.get(rule.category) ?? [];
    items.push(rule);
    groups.set(rule.category, items);
  }
  return [...groups.entries()]
    .toSorted(([left], [right]) => categoryLabel(left).localeCompare(categoryLabel(right)))
    .map(([category, items]) => [category, items.toSorted(compareRules)] as const);
}

function isWithin(routePath: string, basePath: string) {
  return routePath === basePath || routePath.startsWith(`${basePath}/`);
}

function compareRules(left: RuleNavigationEntry, right: RuleNavigationEntry) {
  return left.title.localeCompare(right.title) || left.ruleId.localeCompare(right.ruleId);
}

function ruleNavigationTitle(rule: RuleNavigationEntry) {
  return (typeof rule.navigation === "object" && rule.navigation.title) || rule.title;
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
