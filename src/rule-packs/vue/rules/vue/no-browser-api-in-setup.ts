import { AnyNode, BROWSER_GLOBALS, createRule, report } from "./shared.js";

export const noBrowserApiInSetup = createRule({
  meta: {
    id: "vue/ssr/no-browser-api-in-setup",
    title: "Do not read browser APIs in SSR setup paths",
    category: "ssr",
    severity: "error",
    fixable: "suggestion",
    docsUrl: "https://vuejs.org/guide/scaling-up/ssr.html#writing-ssr-friendly-code",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    if (ctx.project.framework === "nuxt") return;
    if (!ctx.project.ssr) return;
    return {
      ScriptNode(node: AnyNode) {
        if (
          node.type === "Identifier" &&
          BROWSER_GLOBALS.has(node.name) &&
          !ctx.file.relativePath.includes(".client.") &&
          !ctx.helpers.isTypeOnlyContext(node) &&
          !ctx.helpers.isTypeofOperand(node) &&
          !ctx.helpers.hasLocalBindingBefore(node, ctx.file.text) &&
          !ctx.helpers.isClientOnlyExecutionContext(node, ctx.file.text)
        ) {
          report(
            ctx,
            node,
            "vue/ssr/no-browser-api-in-setup",
            "error",
            "ssr",
            `${node.name} is a browser-only API. Access it inside onMounted(), a client-only plugin, or a guarded client branch.`,
            `Move ${node.name} access into onMounted(), a client-only plugin, or a guarded client branch.`,
          );
        }
      },
    };
  },
});
