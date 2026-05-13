import { nextTick, ref } from "vue";
import { expect, test } from "vite-plus/test";
import { getRuleDocuments, getRuleReports, rulesCollectionSource } from "../../rules/source.js";
import { useRuleExplorer } from "../composables/useRuleExplorer.js";
import { normalizeCatalogRules, type RawRuleEntry } from "./rule-catalog.js";

const sampleRules: RawRuleEntry[] = [
  {
    id: "vue/reactivity/no-ref-as-operand",
    title: "Avoid ref operands",
    description: "Use .value before arithmetic.",
    pack: "vue-doctor/vue",
    severity: "error",
    category: "reactivity",
    fixable: "suggestion",
    docsPath: "/vue/rules/reactivity/no-ref-as-operand",
  },
  {
    id: "nuxt/fetch/no-raw-fetch-in-setup",
    title: "Avoid raw fetch in setup",
    description: "Use Nuxt data utilities.",
    pack: "nuxt-doctor/nuxt",
    severity: "warn",
    category: "fetch",
    fixable: "no",
    docsPath: "/nuxt/rules/fetch/no-raw-fetch-in-setup",
  },
  {
    id: "vite/env/no-secret-prefix",
    title: "Avoid secret env prefixes",
    description: "Keep secrets server-side.",
    pack: "vite-doctor/vite",
    severity: "warn",
    category: "env",
    fixable: "safe",
    docsPath: "/vite/rules/env/no-secret-prefix",
  },
];

test("normalizes generated rule catalog entries", () => {
  const rules = normalizeCatalogRules(sampleRules);

  expect(rules.map((rule) => rule.framework)).toEqual(["vue", "nuxt", "vite"]);
  expect(rules[0]!.docsPath).toBe("/vue/rules/reactivity/no-ref-as-operand");
  expect(rules[2]!.fix).toBe("safe");
  expect(rules[0]!.searchText).toContain("reactivity");
  expect(rules[0]!.searchText).toContain("suggestion");
});

test("rule source exposes canonical docs paths and framework counts", () => {
  const reports = getRuleReports();

  expect(reports.all.catalogVersion).toBe(1);
  expect(reports.all.rules.length).toBeGreaterThan(0);
  expect(reports.all.rules.every((rule) => rule.docsPath?.startsWith("/"))).toBe(true);
  expect(reports.nuxt.rules.length).toBe(
    reports.vue.rules.length +
      reports.nitro.rules.length +
      reports.all.rules.filter((rule) => rule.framework === "nuxt").length,
  );
});

test("rule source emits markdown with frontmatter and body sections", async () => {
  const docs = getRuleDocuments();
  const rule = docs.find((item) => item.examples.length || item.why || item.recommendedReplacement);
  expect(rule).toBeTruthy();

  const markdown = await rulesCollectionSource.getItem(rule!.key);
  expect(markdown).toContain("---");
  expect(markdown).toContain(`ruleId: ${JSON.stringify(rule!.id)}`);
  expect(markdown).toContain("::rule-badges");
  expect(markdown).toContain("## Why it matters");
  expect(markdown).toContain("## Recommended fix");
  expect(markdown).toContain("## Example");
  expect(markdown).not.toContain("## Metadata");
});

test("rule source emits complete documentation for every rule", async () => {
  const docs = getRuleDocuments();
  const incompleteRules = docs.filter(
    (rule) =>
      !rule.description ||
      !rule.why ||
      !rule.recommendedReplacement ||
      !rule.examples.length ||
      rule.examples.some(
        (example) => !example.title || !example.language || !example.invalid || !example.valid,
      ),
  );

  expect(incompleteRules).toEqual([]);
  for (const rule of docs) {
    const markdown = await rulesCollectionSource.getItem(rule.key);
    expect(markdown).toContain("## Why it matters");
    expect(markdown).toContain("## Recommended fix");
    expect(markdown).toContain("## Example");
    expect(markdown).not.toContain("## Metadata");
  }
});

test("rule source emits official useful links when available", async () => {
  const docs = getRuleDocuments();
  const rule = docs.find((item) => item.id === "vue/computed/no-async");
  expect(rule).toBeTruthy();

  const markdown = await rulesCollectionSource.getItem(rule!.key);
  expect(markdown).toContain("## Useful links");
  expect(markdown).toContain("https://vuejs.org/guide/essentials/computed");
  expect(markdown).toContain("https://eslint.vuejs.org/rules/no-async-in-computed-properties");
});

test("rule explorer model filters and sorts rules", async () => {
  const rules = ref(sampleRules);
  const model = useRuleExplorer({
    rules,
    currentFramework: () => "all",
    frameworkTabsMode: () => "filter",
  });

  expect(model.filteredRules.value.map((rule) => rule.ruleId)).toEqual([
    "nuxt/fetch/no-raw-fetch-in-setup",
    "vite/env/no-secret-prefix",
    "vue/reactivity/no-ref-as-operand",
  ]);

  model.frameworkFilter.value = "vue";
  await nextTick();
  expect(model.filteredRules.value.map((rule) => rule.ruleId)).toEqual([
    "vue/reactivity/no-ref-as-operand",
  ]);

  model.search.value = "operand";
  await nextTick();
  expect(model.filteredRules.value.map((rule) => rule.ruleId)).toEqual([
    "vue/reactivity/no-ref-as-operand",
  ]);
});
