import { nextTick, ref } from "vue";
import { expect, test } from "vite-plus/test";
import {
  getDiagnosticDocuments,
  getRuleDocuments,
  getRuleReports,
  diagnosticsCollectionSource,
  rulesCollectionSource,
} from "../../rules/source.js";
import { useRuleExplorer } from "../composables/useRuleExplorer.js";
import { normalizeCatalogRules, type RawRuleEntry } from "./rule-catalog.js";
import { appendRulesNavigation, createRulesNavigation } from "./rules-navigation.js";
import { allDiagnostics } from "../../../src/core/index.ts";

const internalDiagnosticCodes = [
  "DOC0012",
  "DOC0013",
  "DOC0014",
  "DOC0015",
  "DOC0016",
  "DOC0017",
  "DOC0018",
  "DOC0019",
  "DOC0020",
  "DOC0021",
] as const;

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
  expect(reports.typescript.rules).toHaveLength(8);
  expect(reports.nuxt.rules.length).toBe(
    reports.vue.rules.length +
      reports.nitro.rules.length +
      reports.all.rules.filter((rule) => rule.framework === "nuxt").length,
  );
});

test("selected rules expose official upstream documentation anchors", () => {
  const docsById = new Map(getRuleDocuments().map((rule) => [rule.id, rule.docsUrl]));

  expect(Object.fromEntries(docsById)).toMatchObject({
    "nuxt/fetch/no-raw-fetch-in-setup":
      "https://nuxt.com/docs/4.x/getting-started/data-fetching#the-need-for-usefetch-and-useasyncdata",
    "nuxt-image/require-alt": "https://image.nuxt.com/usage/nuxt-img#alt",
    "vite/assets/no-public-src-import": "https://vite.dev/guide/assets.html#the-public-directory",
    "vue/reactivity/no-ref-as-operand": "https://vuejs.org/api/reactivity-core.html#ref",
    "nitro/request/prefer-assert-method":
      "https://h3.dev/utils/request#assertmethodevent-expected-allowhead",
    "nitro/request/prefer-validated-body":
      "https://h3.dev/utils/request#readvalidatedbodyevent-validate",
  });
});

test("rule source emits markdown with frontmatter and body sections", async () => {
  const docs = getRuleDocuments();
  const rule = docs.find((item) => item.examples.length || item.why || item.recommendedReplacement);
  expect(rule).toBeTruthy();

  const markdown = await rulesCollectionSource.getItem(rule!.key);
  expect(markdown).toContain("---");
  expect(markdown).toContain(`ruleId: ${JSON.stringify(rule!.id)}`);
  expect(markdown).toContain("::rule-metadata");
  expect(markdown).toContain("sourceUrl:");
  expect(markdown).toContain("docsUrl:");
  expect(markdown).toContain("## Run this rule");
  expect(markdown).toContain("## Why it matters");
  expect(markdown).toContain("## Recommended fix");
  expect(markdown).toContain("## Example");
  expect(markdown).not.toContain("## Metadata");
});

test("diagnostic source carries upstream docs as reference links", async () => {
  const diagnostic = getDiagnosticDocuments().find(
    (item) =>
      item.ruleId === "nuxt/hydration/no-time-dependent-render-without-nuxttime-or-clientonly",
  );

  expect(diagnostic?.docsUrl).toBe(
    "https://nuxt.com/docs/4.x/guide/best-practices/hydration#dynamic-content-based-on-time",
  );

  const markdown = await diagnosticsCollectionSource.getItem(diagnostic!.key);
  expect(markdown).toContain("docsUrl:");
  expect(markdown).toContain("## Useful links");
  expect(markdown).toContain(
    "[Upstream docs](https://nuxt.com/docs/4.x/guide/best-practices/hydration#dynamic-content-based-on-time)",
  );
});

test("unresolved runtime inventory has a public diagnostic reference", async () => {
  const diagnostic = getDiagnosticDocuments().find((item) => item.code === "DOC0022");

  expect(diagnostic?.ruleId).toBe("doctor/inventory/unresolved-runtime");
  expect(await diagnosticsCollectionSource.getItem(diagnostic!.key)).toContain(
    "Doctor suppresses those diagnostics",
  );
});

test("internal diagnostics stay out of generated diagnostic references", async () => {
  const publicCodes = new Set(getDiagnosticDocuments().map((diagnostic) => diagnostic.code));
  const generatedKeys = await diagnosticsCollectionSource.getKeys();

  for (const code of internalDiagnosticCodes) {
    expect(publicCodes.has(code)).toBe(false);
    expect(generatedKeys).not.toContain(`diagnostics/${code}.md`);
    expect(
      allDiagnostics[code]({
        why: `${code} is internal.`,
        fix: "Keep the actionable fix in the diagnostic itself.",
      }).docs,
    ).toBeUndefined();
  }
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
    expect(markdown).toContain("## Run this rule");
    expect(markdown).toContain("## Why it matters");
    expect(markdown).toContain("## Recommended fix");
    expect(markdown).toContain("## Example");
    expect(markdown).not.toContain("## Metadata");
  }
});

test("rules navigation uses diagnostic codes for multi-line registry entries", () => {
  const diagnostics = getDiagnosticDocuments();
  const navigation = createRulesNavigation(
    getRuleDocuments().map((rule) => ({
      path: rule.path,
      title: rule.title,
      ruleId: rule.id,
      category: rule.category,
      framework: rule.framework,
      pack: rule.pack,
    })),
    diagnostics,
  );

  expect(
    diagnostics.find(
      (diagnostic) =>
        diagnostic.ruleId ===
        "nuxt/hydration/no-time-dependent-render-without-nuxttime-or-clientonly",
    )?.code,
  ).toBe("NUXT0032");
  expect(
    navigation
      .find((item) => item.path === "/nuxt")
      ?.children?.find(
        (child) =>
          child.path ===
          "/nuxt/rules/hydration/no-time-dependent-render-without-nuxttime-or-clientonly",
      )?.title,
  ).toBe("NUXT0032");
});

test("rules navigation keeps framework overview pages above rule links", () => {
  const navigation = createRulesNavigation(sampleRules, [
    { code: "VUE0001", ruleId: "vue/reactivity/no-ref-as-operand" },
    { code: "NUXT0001", ruleId: "nuxt/fetch/no-raw-fetch-in-setup" },
    { code: "VITE0001", ruleId: "vite/env/no-secret-prefix" },
  ]);

  expect(navigation.map((item) => item.title)).toEqual([
    "TypeScript",
    "Nuxt",
    "Vue",
    "Vite",
    "Nitro",
  ]);

  expect(navigation.flatMap((item) => item.children?.map((child) => child.title) ?? [])).toEqual([
    "Installation",
    "TypeScript rules",
    "Installation",
    "Nuxt rules",
    "NUXT0001",
    "Installation",
    "Vue rules",
    "VUE0001",
    "Installation",
    "Vite rules",
    "VITE0001",
    "Installation",
    "Nitro rules",
  ]);

  expect(navigation.flatMap((item) => item.children?.map((child) => child.path) ?? [])).toEqual([
    "/typescript",
    "/typescript/rules",
    "/nuxt",
    "/nuxt/rules",
    "/nuxt/rules/fetch/no-raw-fetch-in-setup",
    "/vue",
    "/vue/rules",
    "/vue/rules/reactivity/no-ref-as-operand",
    "/vite",
    "/vite/rules",
    "/vite/rules/env/no-secret-prefix",
    "/nitro",
    "/nitro/rules",
  ]);

  expect(
    appendRulesNavigation([{ title: "CLI", path: "/cli" }], navigation).map((item) => item.title),
  ).toEqual(["CLI", "TypeScript", "Nuxt", "Vue", "Vite", "Nitro"]);
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
