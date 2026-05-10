import { createEslintVueRule } from "./shared.js";

export const noAfterAwait = createEslintVueRule({
  doctorId: "vue/watch/no-after-await",
  eslintId: "vue/no-watch-after-await",
  meta: {
    id: "vue/watch/no-after-await",
    title: "Register watchers and lifecycle hooks before await",
    category: "watchers",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, vue: true },
  },
});
