import { createEslintVueRule } from "./shared.js";

export const noRefAsOperand = createEslintVueRule({
  doctorId: "vue/reactivity/no-ref-as-operand",
  eslintId: "vue/no-ref-as-operand",
  meta: {
    id: "vue/reactivity/no-ref-as-operand",
    title: "Use .value when refs are operands",
    category: "reactivity",
    severity: "error",
    fixable: "suggestion",
    docsUrl: "https://vuejs.org/api/reactivity-core.html#ref",
    requires: { script: true, vue: true },
  },
});
