import { createEslintVueRule } from "./shared.js";

export const noMutatingProps = createEslintVueRule({
  doctorId: "vue/props/no-mutating-props",
  eslintId: "vue/no-mutating-props",
  meta: {
    id: "vue/props/no-mutating-props",
    title: "Do not mutate props",
    category: "props",
    severity: "error",
    docsUrl: "https://vuejs.org/guide/components/props.html#one-way-data-flow",
    requires: { script: true, vue: true },
  },
});
