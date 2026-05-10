import { AnyNode, createRule } from "./shared.js";

export const returnNavigateToInMiddleware = createRule({
  meta: {
    id: "nuxt/routing/return-navigateto-in-middleware",
    title: "Return navigateTo in route middleware",
    category: "routing",
    severity: "error",
    fixable: "safe",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (
      !ctx.file.relativePath.includes("/middleware/") &&
      !ctx.file.relativePath.startsWith("middleware/") &&
      !ctx.file.relativePath.startsWith("app/middleware/")
    )
      return;
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "navigateTo")) return;
        const fixStart =
          node.__doctorParent?.type === "AwaitExpression" ? node.__doctorParent.start : node.start;
        const before = ctx.file.text.slice(Math.max(0, fixStart - 20), fixStart);
        if (!/\breturn\s+$/.test(before)) {
          ctx.report({
            ruleId: "nuxt/routing/return-navigateto-in-middleware",
            severity: "error",
            category: "routing",
            file: ctx.file.path,
            range: ctx.range(node),
            message:
              "Route middleware must return navigateTo() so Nuxt can stop or redirect the navigation.",
            suggestion: "Add return before navigateTo().",
            fix: {
              kind: "safe",
              edits: [{ range: { start: fixStart, end: fixStart }, text: "return " }],
            },
          });
        }
      },
    };
  },
});
