import { createEslintVueRule } from "./shared.js";

export const noRequiredPropWithDefault = createEslintVueRule({
  doctorId: "vue/props/no-required-prop-with-default",
  eslintId: "vue/no-required-prop-with-default",
  meta: {
    id: "vue/props/no-required-prop-with-default",
    title: "Do not give required props a default",
    category: "props",
    severity: "warn",
    docsUrl: "https://vuejs.org/guide/components/props.html#prop-validation",
    requires: { script: true, vue: true },
  },
});
