import { createEslintVueRule } from "./shared.js";

export const noComputedSideEffects = createEslintVueRule({
  doctorId: "vue/reactivity/no-computed-side-effects",
  eslintId: ["vue/no-side-effects-in-computed-properties", "vue/no-async-in-computed-properties"],
  // Only the async check takes options (`ignoredObjectNames`); the side-effect check rejects any.
  eslintOptions: (options, eslintId) =>
    eslintId === "vue/no-async-in-computed-properties" ? options : undefined,
  // An `await` can only sit directly in an async getter, which is already reported once.
  keepMessage: (message) => !message.message.startsWith("Unexpected await operator in "),
  meta: {
    id: "vue/reactivity/no-computed-side-effects",
    title: "Keep computed getters pure and synchronous",
    category: "reactivity",
    severity: "error",
    docsUrl: "https://vuejs.org/guide/essentials/computed.html#getters-should-be-side-effect-free",
    requires: { script: true, vue: true },
  },
});
