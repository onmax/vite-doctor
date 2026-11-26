import { defineRulePack } from "../../core/index.js";
import {
  noArbitraryValues,
  noInlineStyles,
  noRawColors,
  designSystemRules,
} from "./rules/index.js";

export * from "./rules/index.js";
export { diagnostics, designSystemDiagnosticRegistry } from "./diagnostics.js";

const designSystemRulePack = defineRulePack({
  name: "vite-doctor/design-system",
  version: "0.0.0",
  activation: { packages: ["tailwindcss"] },
  rules: designSystemRules,
  presets: {
    recommended: [noRawColors, noArbitraryValues, noInlineStyles].map((rule) => rule.meta.id),
    strict: designSystemRules.map((rule) => rule.meta.id),
  },
});

export { designSystemRulePack };
export default designSystemRulePack;
