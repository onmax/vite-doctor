import { createEslintVueRule } from "./shared.js";

export const noVIfWithVFor = createEslintVueRule({
  doctorId: "vue/template/no-v-if-with-v-for",
  eslintId: "vue/no-use-v-if-with-v-for",
  meta: {
    id: "vue/template/no-v-if-with-v-for",
    title: "Do not combine v-if and v-for on the same element",
    category: "template",
    severity: "error",
    fixable: "suggestion",
    requires: { template: true, vue: true },
  },
});
