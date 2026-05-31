import { AnyNode, createRule, report } from "./shared.js";

export const keyedComposableRegistrationRequired = createRule({
  meta: {
    id: "nuxt/fetch/keyed-composable-registration-required",
    title: "Register custom keyed data composables",
    category: "fetching",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/api/composables/create-use-fetch#usage",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        const name = ctx.helpers.getCalleeName(node);
        if (name !== "createUseFetch" && name !== "createUseAsyncData") return;
        const decl = ctx.file.text.slice(Math.max(0, node.start - 120), node.start);
        const match = decl.match(/use[A-Z]\w+/);
        const composable = match?.[0];
        if (composable && ctx.project.nuxt?.manifest?.keyedComposables.includes(composable)) return;
        report(
          ctx,
          node,
          "nuxt/fetch/keyed-composable-registration-required",
          "warn",
          "fetching",
          "Custom data factory composables should be registered for key injection.",
          "Add the composable name to Nuxt keyed composables configuration when it is not auto-detected.",
        );
      },
    };
  },
});
