import { createEslintVueRule } from "./shared.js";

export const computedNoSideEffects = createEslintVueRule({
  doctorId: "vue/computed/no-side-effects",
  eslintId: "vue/no-side-effects-in-computed-properties",
  meta: {
    id: "vue/computed/no-side-effects",
    title: "Computed getters should be pure",
    category: "computed",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, vue: true },
  },
});
