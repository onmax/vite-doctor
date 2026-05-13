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
  id: string;
  ruleId: string;
  title: string;
  description: string;
  pack: string;
  severity: Severity;
  category: string;
  fix: FixKind;
  docsUrl?: string;
  path: string;
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
  _currentFramework: FrameworkFilter = "all",
): CatalogRule[] {
  return rules.map((rule) => {
    const fix = rule.fix;
    const framework = rule.framework || frameworkOfPack(rule.pack);
    const ruleId = rule.ruleId || rule.id;
    const docsPath = rule.path;
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
