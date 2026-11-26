import { defineRulePack } from "../../core/index.js";
import {
  noArbitraryValues,
  noInlineStyles,
  noRawColors,
  designSystemRules,
  preferProjectComponent,
  unreadableContract,
} from "./rules/index.js";

export * from "./rules/index.js";
export * from "./contracts.js";
export { diagnostics, designSystemDiagnosticRegistry } from "./diagnostics.js";

const designSystemRulePack = defineRulePack({
  name: "vite-doctor/design-system",
  version: "0.0.0",
  activation: { packages: ["tailwindcss", "@nuxt/ui"] },
  rules: designSystemRules,
  presets: {
    recommended: [
      noRawColors,
      noArbitraryValues,
      noInlineStyles,
      preferProjectComponent,
      unreadableContract,
    ].map((rule) => rule.meta.id),
    strict: designSystemRules.map((rule) => rule.meta.id),
  },
});

export { designSystemRulePack };
export default designSystemRulePack;
