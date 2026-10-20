import { createEslintVueRule } from "./shared.js";

export const noVIfWithVFor = createEslintVueRule({
  doctorId: "vue/template/no-v-if-with-v-for",
  eslintId: "vue/no-use-v-if-with-v-for",
  // A `v-if` that ignores the loop variable still renders the whole list or nothing in Vue 3, so
  // only the variant that reads the loop variable is a defect.
  keepMessage: (message) => message.messageId === "shouldUseComputed",
  meta: {
    id: "vue/template/no-v-if-with-v-for",
    title: "Do not read v-for variables in v-if on the same element",
    category: "template",
    severity: "error",
    docsUrl: "https://vuejs.org/guide/essentials/list.html#v-for-with-v-if",
    requires: { template: true, vue: true },
  },
});
