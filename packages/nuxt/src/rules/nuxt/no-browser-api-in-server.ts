import { AnyNode, BROWSER_GLOBALS, createRule, report } from "./shared.js";

export const noBrowserApiInServer = createRule({
  meta: {
    id: "nuxt/server/no-browser-api",
    title: "Do not use browser APIs in Nitro server files",
    category: "server",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Identifier" || !BROWSER_GLOBALS.has(node.name)) return;
        if (
          ctx.helpers.isTypeOnlyContext(node) ||
          ctx.helpers.hasLocalBindingBefore(node, ctx.file.text)
        )
          return;
        report(
          ctx,
          node,
          "nuxt/server/no-browser-api",
          "error",
          "server",
          `${node.name} is not available in Nitro server runtime.`,
          "Use request/event data, server utilities, or move browser work to app client code.",
        );
      },
    };
  },
});
