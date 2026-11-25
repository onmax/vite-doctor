import { defineRulePack } from "../../core/index.js";
import { h3RecommendedRuleIds } from "./presets.js";
import { h3Rules } from "./rules/index.js";

export * from "./rules/index.js";
export { diagnostics, h3DiagnosticRegistry } from "./diagnostics.js";

export const h3RulePack = defineRulePack({
  name: "vite-doctor/h3",
  version: "0.0.0",
  activation: { frameworks: ["nitro", "nuxt"] },
  rules: h3Rules,
  presets: {
    recommended: h3RecommendedRuleIds,
    strict: h3Rules.map((rule) => rule.meta.id),
  },
});

export default h3RulePack;
