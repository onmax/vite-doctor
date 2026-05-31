import { AnyNode, BROWSER_SIDE_EFFECTS, createRule, isNuxtRuntimeFile, report } from "./shared.js";

export const noBrowserSideEffectsInSetup = createRule({
  meta: {
    id: "nuxt/hydration/no-browser-side-effects-in-setup",
    title: "Avoid browser side effects in universal setup",
    category: "hydration",
    severity: "error",
    fixable: "suggestion",
    docsUrl:
      "https://nuxt.com/docs/4.x/guide/best-practices/hydration#third-party-libraries-with-side-effects",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!isNuxtRuntimeFile(ctx) || ctx.file.relativePath.includes(".client.")) return;
    return {
      ScriptNode(node: AnyNode) {
        const name = ctx.helpers.getCalleeName(node);
        if (name && BROWSER_SIDE_EFFECTS.has(name)) {
          if (ctx.helpers.isTypeOnlyContext(node)) return;
          if (ctx.helpers.isClientOnlyExecutionContext(node, ctx.file.text)) return;
          report(
            ctx,
            node,
            "nuxt/hydration/no-browser-side-effects-in-setup",
            "error",
            "hydration",
            `${name} is a browser-only side effect in universal code. Move it to onMounted() or a client-only plugin.`,
          );
        }
      },
    };
  },
});
