import { AnyNode, BROWSER_GLOBALS, createRule, isObjectPropertyKey, report } from "./shared.js";

export const noBrowserApiInServer = createRule({
  meta: {
    id: "nitro/server/no-browser-api",
    title: "Do not use browser APIs in Nitro server files",
    description: "Browser globals are unavailable in Nitro server runtime.",
    why: "Nitro code can run in Node, edge, or worker runtimes where browser APIs such as window, document, and localStorage do not exist.",
    recommendedReplacement:
      "Use request/event data, server utilities, or move browser work to app client code.",
    category: "server",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nitro: true },
  },
  create(ctx) {
    if (!ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Identifier" || !BROWSER_GLOBALS.has(node.name)) return;
        if (
          ctx.helpers.isTypeOnlyContext(node) ||
          isObjectPropertyKey(node) ||
          ctx.helpers.hasLocalBindingBefore(node, ctx.file.text)
        )
          return;
        report(
          ctx,
          node,
          "nitro/server/no-browser-api",
          "error",
          "server",
          `${node.name} is not available in Nitro server runtime.`,
          "Use request/event data, server utilities, or move browser work to app client code.",
        );
      },
    };
  },
});
