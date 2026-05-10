import {
  AnyNode,
  BROWSER_GLOBALS,
  createRule,
  isClientOnlyPath,
  isKnownGuardedBrowserGlobal,
  isNuxtRuntimeFile,
  isObjectPropertyKey,
  replacementForBrowserGlobal,
  report,
} from "./shared.js";

export const noBrowserGlobalInUniversalCode = createRule({
  meta: {
    id: "nuxt/hydration/no-browser-global-in-universal-code",
    title: "Avoid browser globals in universal code",
    category: "hydration",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (
      !isNuxtRuntimeFile(ctx) ||
      isClientOnlyPath(ctx.file.relativePath) ||
      ctx.helpers.isNuxtServerFile(ctx.file.relativePath)
    )
      return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Identifier" || !BROWSER_GLOBALS.has(node.name)) return;
        if (
          isObjectPropertyKey(node) ||
          ctx.helpers.isTypeOnlyContext(node) ||
          ctx.helpers.isTypeofOperand(node) ||
          ctx.helpers.hasLocalBindingBefore(node, ctx.file.text) ||
          isKnownGuardedBrowserGlobal(ctx.file.text, node.start) ||
          ctx.helpers.isClientOnlyExecutionContext(node, ctx.file.text)
        )
          return;
        report(
          ctx,
          node,
          "nuxt/hydration/no-browser-global-in-universal-code",
          "error",
          "hydration",
          `${node.name} is browser-only and this file can run during SSR.`,
          replacementForBrowserGlobal(node.name),
        );
      },
    };
  },
});
