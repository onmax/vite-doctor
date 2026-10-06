import { defineRulePack } from "../../core/index.js";
import { piniaRecommendedRuleIds } from "./presets.js";
import { piniaRules } from "./rules/index.js";

export * from "./rules/index.js";
export { diagnostics, piniaDiagnosticRegistry } from "./diagnostics.js";

export const piniaRulePack = defineRulePack({
  name: "vite-doctor/pinia",
  version: "0.0.0",
  activation: { packages: ["pinia", "@pinia/nuxt"] },
  rules: piniaRules,
  presets: {
    recommended: piniaRecommendedRuleIds,
    strict: piniaRules.map((rule) => rule.meta.id),
  },
});

export default piniaRulePack;
