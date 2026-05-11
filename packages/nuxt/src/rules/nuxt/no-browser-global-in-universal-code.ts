import {
  AnyNode,
  BROWSER_GLOBALS,
  createRule,
  hasPriorServerReturnGuard,
  isClientOnlyPath,
  isKnownGuardedBrowserGlobal,
  isNuxtRuntimeFile,
  isObjectPropertyKey,
  isVueUseBrowserGlobalTarget,
  replacementForBrowserGlobal,
  report,
} from "./shared.js";
import { createNuxtRuntimeEvidence } from "./evidence.js";

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
    const evidence = createNuxtRuntimeEvidence(ctx);
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
          hasPriorServerReturnGuard(ctx.file.text, node.start) ||
          isVueUseBrowserGlobalTarget(node) ||
          evidence.isClientCallable(node) ||
          ctx.helpers.isClientOnlyExecutionContext(node, ctx.file.text)
        )
          return;
        const severity = evidence.isSourceOnlyExecution(node) ? "warn" : "error";
        report(
          ctx,
          node,
          "nuxt/hydration/no-browser-global-in-universal-code",
          severity,
          "hydration",
          `${node.name} is browser-only and this file can run during SSR.`,
          replacementForBrowserGlobal(node.name),
        );
      },
    };
  },
});
