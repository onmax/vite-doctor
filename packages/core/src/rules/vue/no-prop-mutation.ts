import { createEslintVueRule } from "./shared.js";

export const noPropMutation = createEslintVueRule({
  doctorId: "vue/reactivity/no-prop-mutation",
  eslintId: "vue/no-mutating-props",
  meta: {
    id: "vue/reactivity/no-prop-mutation",
    title: "Do not mutate props",
    category: "reactivity",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, vue: true },
  },
});
