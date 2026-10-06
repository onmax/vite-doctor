/**
 * The ported Rules. `doctor` is the Doctor Rule ID, `oxlint` the rule name inside the
 * `doctor` oxlint JS plugin, `code` the Diagnostic Code both engines must emit.
 */
export const portedRules = [
  {
    doctor: "typescript/boundaries/no-unvalidated-deserialization",
    oxlint: "no-unvalidated-deserialization",
    code: "TS0005",
    shape: "simple callee filter, typed visitors",
  },
  {
    doctor: "vite/assets/no-public-src-import",
    oxlint: "no-public-src-import",
    code: "VITE0002",
    shape: "import-based, needs Vite + Nuxt Project Inventory",
  },
  {
    doctor: "vite/assets/no-dynamic-new-url",
    oxlint: "no-dynamic-new-url",
    code: "VITE0001",
    shape: "callee filter + Vite alias inventory (RegExp aliases)",
  },
  {
    doctor: "vue/reactivity/no-setup-props-destructure",
    oxlint: "no-setup-props-destructure",
    code: "VUE0007",
    shape: "scope/binding-heavy Vue script Rule",
  },
  {
    doctor: "nitro/request/prefer-validated-query",
    oxlint: "prefer-validated-query",
    code: "NITRO0006",
    shape: "Nitro server Rule, scope references + framework inventory",
  },
  {
    doctor: "nuxt/fetch/no-raw-fetch-in-setup",
    oxlint: "no-raw-fetch-in-setup",
    code: "NUXT0026",
    shape: "Nuxt Rule gated by Project Inventory (app dir, SFC)",
  },
];

export const pluginName = "doctor";

export function oxlintRuleId(rule) {
  return `${pluginName}/${rule.oxlint}`;
}
