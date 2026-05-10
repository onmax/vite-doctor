import { createEslintVueRule } from "./shared.js";

export const computedNoAsync = createEslintVueRule({
  doctorId: "vue/computed/no-async",
  eslintId: "vue/no-async-in-computed-properties",
  meta: {
    id: "vue/computed/no-async",
    title: "Do not use async computed getters",
    category: "computed",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, vue: true },
  },
});
