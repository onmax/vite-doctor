import { nextTick, ref } from "vue";
import { expect, test } from "vite-plus/test";
import { getRuleDocuments, getRuleReports, rulesCollectionSource } from "../../rules/source.js";
import { useRuleExplorer } from "../composables/useRuleExplorer.js";
import { normalizeCatalogRules, type RawRuleEntry } from "./rule-catalog.js";
import { appendRulesNavigation, createRulesNavigation } from "./rules-navigation.js";

const sampleRules: RawRuleEntry[] = [
  {
    id: "vue/reactivity/no-ref-as-operand",
    title: "Avoid ref operands",
    description: "Use .value before arithmetic.",
    pack: "vite-doctor/vue",
    severity: "error",
    category: "reactivity",
    fix: "suggestion",
    ruleId: "vue/reactivity/no-ref-as-operand",
    path: "/vue/rules/reactivity/no-ref-as-operand",
  },
  {
    id: "nuxt/fetch/no-raw-fetch-in-setup",
    title: "Avoid raw fetch in setup",
    description: "Use Nuxt data utilities.",
    pack: "vite-doctor/nuxt",
    severity: "warn",
    category: "fetch",
    fix: "no",
    ruleId: "nuxt/fetch/no-raw-fetch-in-setup",
    path: "/nuxt/rules/fetch/no-raw-fetch-in-setup",
  },
  {
    id: "vite/env/no-secret-prefix",
    title: "Avoid secret env prefixes",
    description: "Keep secrets server-side.",
    pack: "vite-doctor/vite",
    severity: "warn",
    category: "env",
    fix: "safe",
    ruleId: "vite/env/no-secret-prefix",
    path: "/vite/rules/env/no-secret-prefix",
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
        (example) =>
          !example.title ||
          !example.language ||
          !example.invalid ||
          !example.valid ||
          example.invalid.trim() === example.valid.trim(),
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

test("rules navigation keeps framework overview pages above rule links", () => {
  const navigation = createRulesNavigation(sampleRules, [
    { code: "VUE0001", ruleId: "vue/reactivity/no-ref-as-operand" },
    { code: "NUXT0001", ruleId: "nuxt/fetch/no-raw-fetch-in-setup" },
    { code: "VITE0001", ruleId: "vite/env/no-secret-prefix" },
  ]);

  expect(navigation.children?.map((item) => item.title)).toEqual([
    "Nuxt rules",
    "NUXT0001",
    "Vue rules",
    "VUE0001",
    "Nitro rules",
    "Vite rules",
    "VITE0001",
  ]);

  expect(navigation.children?.map((item) => item.path)).toEqual([
    "/rules/nuxt",
    "/nuxt/rules/fetch/no-raw-fetch-in-setup",
    "/rules/vue",
    "/vue/rules/reactivity/no-ref-as-operand",
    "/rules/nitro",
    "/rules/vite",
    "/vite/rules/env/no-secret-prefix",
  ]);

  expect(
    appendRulesNavigation([{ title: "CLI", path: "/cli" }], navigation).map((item) => item.title),
  ).toEqual(["CLI", "Rules"]);
});

test("rule examples do not reuse generic placeholders", () => {
  const placeholderExamples = getRuleDocuments().flatMap((rule) =>
    rule.examples
      .filter((example) => {
        const pair = `${example.invalid}\n${example.valid}`;
        return (
          (pair.includes("props.count++") && pair.includes("defineModel")) ||
          (rule.id !== "nitro/server/prefer-event-fetch" &&
            !rule.id.startsWith("nitro/request/prefer-validated-") &&
            pair.includes("readBody(event)") &&
            pair.includes("readValidatedBody(event")) ||
          (pair.includes("const route = useRoute()") &&
            pair.includes("nuxtApp.hook('page:finish'")) ||
          (pair.includes("useFetch('/api/orders'") && pair.includes("key: 'orders'"))
        );
      })
      .map((example) => `${rule.id}: ${example.title}`),
  );

  expect(placeholderExamples).toEqual([]);
});

test("fetch factory docs demonstrate createUseFetch", async () => {
  const docs = getRuleDocuments();
  const rule = docs.find((item) => item.id === "nuxt/fetch/prefer-create-use-fetch");

  expect(rule).toBeTruthy();
  expect(rule!.examples[0]!.invalid).toContain("useFetch('/api/orders')");
  expect(rule!.examples[0]!.valid).toContain("createUseFetch('/api/orders')");
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
