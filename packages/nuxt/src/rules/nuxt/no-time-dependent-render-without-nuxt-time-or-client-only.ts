import {
  AnyNode,
  createRule,
  isClientOnlyPath,
  isNewDate,
  isNuxtRuntimeFile,
  report,
} from "./shared.js";

export const noTimeDependentRenderWithoutNuxtTimeOrClientOnly = createRule({
  meta: {
    id: "nuxt/hydration/no-time-dependent-render-without-nuxttime-or-clientonly",
    title: "Use NuxtTime or ClientOnly for time-dependent rendering",
    category: "hydration",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (
      !isNuxtRuntimeFile(ctx) ||
      isClientOnlyPath(ctx.file.relativePath) ||
      ctx.helpers.isNuxtServerFile(ctx.file.relativePath) ||
      /<\s*(NuxtTime|ClientOnly)\b/.test(ctx.file.text)
    )
      return;
    return {
      ScriptNode(node: AnyNode) {
        const name = ctx.helpers.getCalleeName(node);
        if (name !== "Date.now" && name !== "Math.random" && !isNewDate(node)) return;
        if (ctx.helpers.isTypeOnlyContext(node)) return;
        if (ctx.helpers.isClientOnlyExecutionContext(node, ctx.file.text)) return;
        report(
          ctx,
          node,
          "nuxt/hydration/no-time-dependent-render-without-nuxttime-or-clientonly",
          "warn",
          "hydration",
          "Time-dependent values rendered during SSR can differ by the time the client hydrates.",
          "Use <NuxtTime>, useState() with a stable value, or <ClientOnly> for client-only time output.",
        );
      },
    };
  },
});
