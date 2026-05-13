import {
  categoryLabel,
  fixLabel,
  frameworkOfPack,
  type FixKind,
  type Framework,
  type FrameworkFilter,
  type Severity,
} from "./rule-metadata.js";

export interface RawRuleEntry {
  id?: string;
  ruleId?: string;
  title: string;
  description: string;
  pack: string;
  severity: Severity;
  category: string;
  fixable?: FixKind;
  fix?: FixKind;
  docsUrl?: string;
  docsPath?: string;
  path?: string;
  framework?: Framework;
  body?: unknown;
  source?: string;
  sourceUrl?: string;
}

export interface RulesReport {
  catalogVersion?: number;
  rules: RawRuleEntry[];
}

export interface CatalogRule {
  docsPath: string;
  path: string;
  title: string;
  description: string;
  ruleId: string;
  pack: string;
  severity: Severity;
  category: string;
  fix: FixKind;
  framework: Framework;
  searchText: string;
  body?: unknown;
  source?: string;
  sourceUrl?: string;
  docsUrl?: string;
}

export function normalizeCatalogRules(
  rules: RawRuleEntry[],
  currentFramework: FrameworkFilter = "all",
): CatalogRule[] {
  return rules.map((rule) => {
    const fix = rule.fix || rule.fixable || "no";
    const framework = rule.framework || frameworkOfPack(rule.pack);
    const ruleId = rule.ruleId || rule.id || "";
    const docsPath =
      rule.path || rule.docsPath || fallbackRuleHref({ ...rule, id: ruleId }, currentFramework);
    const normalized = {
      docsPath,
      path: docsPath,
      title: rule.title,
      description: rule.description,
      ruleId,
      pack: rule.pack,
      severity: rule.severity,
      category: rule.category,
      fix,
      framework,
      body: rule.body,
      source: rule.source,
      sourceUrl: rule.sourceUrl,
      docsUrl: rule.docsUrl,
    };
    return {
      ...normalized,
      searchText: [
        normalized.ruleId,
        normalized.title,
        normalized.description,
        normalized.pack,
        normalized.category,
        categoryLabel(normalized.category),
        normalized.severity,
        fixLabel(normalized.fix),
      ]
        .join(" ")
        .toLowerCase(),
    };
  });
}

function fallbackRuleHref(rule: RawRuleEntry, currentFramework: FrameworkFilter) {
  const base =
    rule.pack === "nuxt-doctor/nitro"
      ? "/nitro/rules"
      : rule.pack.startsWith("vite-doctor/")
        ? "/vite/rules"
        : rule.pack.startsWith("vue-doctor/")
          ? "/vue/rules"
          : currentFramework === "vue"
            ? "/vue/rules"
            : "/nuxt/rules";
  return `${base}/${ruleDocsPath(rule)}`;
}

export function ruleDocsPath(rule: Pick<RawRuleEntry, "id" | "category" | "pack">) {
  const id = rule.id || "";
  const parts = id.split("/");
  const pathParts =
    parts.length > 2
      ? parts.slice(1)
      : [rule.category || rule.pack.split("/").at(-1) || "rules", parts.at(-1) || id];
  return pathParts.map((part) => slugSegment(part || "")).join("/");
}

function slugSegment(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
