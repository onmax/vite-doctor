import { AnyNode, createRule, isExplicitlyScannedByNuxt } from "./shared.js";

export const noNestedSharedAutoimportAssumption = createRule({
  meta: {
    id: "nuxt/shared/no-nested-shared-autoimport-assumption",
    title: "Only shared utils and types are auto-imported",
    category: "imports",
    severity: "warn",
    fixable: "suggestion",
    requires: { nuxt: true },
  },
  create(ctx) {
    if (!/^shared\/(utils|types)\/[^/]+\/.+\.[cm]?[jt]s$/.test(ctx.file.relativePath)) return;
    if (isExplicitlyScannedByNuxt(ctx, "shared")) return;
    let reported = false;
    const reportOnce = () => {
      if (reported) return;
      reported = true;
      ctx.report({
        ruleId: "nuxt/shared/no-nested-shared-autoimport-assumption",
        severity: "warn",
        category: "imports",
        file: ctx.file.path,
        message: ctx.project.nuxt?.manifest?.hasManifest
          ? "This nested shared export is not included in Nuxt's configured shared scan roots."
          : "Nuxt only auto-imports shared/utils and shared/types entries by default, not arbitrary nested files.",
        suggestion:
          "Move the export to a top-level shared/utils or shared/types file, or import it explicitly.",
      });
    };
    return {
      ScriptNode(node: AnyNode) {
        if (node.type === "Program") reportOnce();
      },
    };
  },
});
