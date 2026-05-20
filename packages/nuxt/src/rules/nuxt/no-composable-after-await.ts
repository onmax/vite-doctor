import {
  AnyNode,
  NUXT_AUTO_IMPORTS,
  createRule,
  findAncestor,
  hasPriorAwaitInSameExecutionScope,
  isClientOnlyPath,
  isNuxtRuntimeFile,
  isTopLevelVueScriptSetupCall,
  nearestFunctionOrProgram,
  report,
  resolveLocalCalleeName,
} from "./shared.js";
import { createNuxtRuntimeEvidence } from "./evidence.js";

export const noComposableAfterAwait = createRule({
  meta: {
    id: "nuxt/context/no-composable-after-await",
    title: "Call Nuxt composables before await",
    category: "context",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    const evidence = createNuxtRuntimeEvidence(ctx);
    if (!isNuxtRuntimeFile(ctx) || isClientOnlyPath(ctx.file.relativePath)) return;
    const composables = new Set([...NUXT_AUTO_IMPORTS, "useSeoMeta", "useHead", "useHeadSafe"]);
    return {
      ScriptNode(node: AnyNode) {
        const name = resolveLocalCalleeName(ctx, node);
        if (!name || !composables.has(name) || !hasPriorAwaitInSameExecutionScope(node)) return;
        if (isTopLevelVueScriptSetupCall(ctx, node)) return;
        if (name === "navigateTo" && isReturnedFromRouteMiddleware(ctx.file.relativePath, node))
          return;
        if (name === "navigateTo" && isVueComponentFunctionNavigation(ctx.file.relativePath, node))
          return;
        if (evidence.isClientCallable(node)) return;
        if (ctx.helpers.isClientOnlyExecutionContext(node, ctx.file.text)) return;
        report(
          ctx,
          node,
          "nuxt/context/no-composable-after-await",
          "error",
          "context",
          `${name}() is called after await in Nuxt context and may lose async context.`,
          "Call Nuxt composables before the first await or use Nuxt's compiler-aware data factories.",
        );
      },
    };
  },
});

function isReturnedFromRouteMiddleware(path: string, node: AnyNode): boolean {
  if (!/app\/middleware\/.+\.[cm]?[jt]s$/.test(path)) return false;
  const returned = findAncestor(node, (parent) => parent.type === "ReturnStatement") !== null;
  if (!returned) return false;
  return (
    findAncestor(
      node,
      (parent) =>
        parent.type === "CallExpression" && parent.callee?.name === "defineNuxtRouteMiddleware",
    ) !== null
  );
}

function isVueComponentFunctionNavigation(path: string, node: AnyNode): boolean {
  if (!path.endsWith(".vue")) return false;
  const fn = nearestFunctionOrProgram(node);
  return Boolean(fn && fn.type !== "Program");
}
