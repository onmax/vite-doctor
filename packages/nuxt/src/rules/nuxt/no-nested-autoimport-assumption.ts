import { AnyNode, createRule, isExplicitlyScannedByNuxt } from "./shared.js";

export const noNestedAutoimportAssumption = createRule({
  meta: {
    id: "nuxt/composables/no-nested-autoimport-assumption",
    title: "Nested composables are not auto-imported by default",
    category: "imports",
    severity: "warn",
    fixable: "suggestion",
    requires: { nuxt: true },
  },
  create(ctx) {
    if (!/^app\/composables\/[^/]+\/.+\.[cm]?[jt]s$/.test(ctx.file.relativePath)) return;
    if (isExplicitlyScannedByNuxt(ctx, "imports")) return;
    let reported = false;
    const reportOnce = () => {
      if (reported) return;
      reported = true;
      ctx.report({
        ruleId: "nuxt/composables/no-nested-autoimport-assumption",
        severity: "warn",
        category: "imports",
        file: ctx.file.path,
        message: ctx.project.nuxt?.manifest?.hasManifest
          ? "This nested composable is not included in Nuxt's configured auto-import scan roots."
          : "Nuxt auto-imports top-level composables by default, not arbitrary nested files.",
        suggestion:
          "Move the composable to app/composables/, export it from an index file, or configure imports.dirs explicitly.",
      });
    };
    return {
      ScriptNode(node: AnyNode) {
        if (node.type === "Program") reportOnce();
      },
    };
  },
});
