import { defineRulePack } from "../../core/index.js";
import {
  noArbitraryValues,
  noInlineStyles,
  noRawColors,
  noRestyle,
  noUnknownClasses,
  requireStaticClasses,
  shadcnRules,
} from "./rules/index.js";

export * from "./rules/index.js";
export { diagnostics, shadcnDiagnosticRegistry } from "./diagnostics.js";

const shadcnRulePack = defineRulePack({
  name: "vite-doctor/shadcn",
  version: "0.0.0",
  activation: { packages: ["tailwindcss"] },
  rules: shadcnRules,
  presets: {
    recommended: [noRawColors, noArbitraryValues, noInlineStyles].map((rule) => rule.meta.id),
    strict: shadcnRules.map((rule) => rule.meta.id),
  },
});

export { shadcnRulePack };
export default shadcnRulePack;
