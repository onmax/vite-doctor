import { AnyNode, createRule, isExplicitlyScannedByNuxt, isGeneratedFile } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

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
    if (isGeneratedFile(ctx)) return;
    if (!/^shared\/(utils|types)\/[^/]+\/.+\.[cm]?[jt]s$/.test(ctx.file.relativePath)) return;
    if (isExplicitlyScannedByNuxt(ctx, "shared")) return;
    let reported = false;
    const reportOnce = () => {
      if (reported) return;
      reported = true;
      ctx.report(
        diagnostics.NUXT0058.report({
          why: ctx.project.nuxt?.manifest?.hasManifest
            ? "This nested shared export is not included in Nuxt's configured shared scan roots."
            : "Nuxt only auto-imports shared/utils and shared/types entries by default, not arbitrary nested files.",
          fix: "Move the export to a top-level shared/utils or shared/types file, or import it explicitly.",
        }),
        {
          ruleId: "nuxt/shared/no-nested-shared-autoimport-assumption",
          severity: "warn",
          category: "imports",
          file: ctx.file.path,
        },
      );
    };
    return {
      ScriptNode(node: AnyNode) {
        if (node.type === "Program") reportOnce();
      },
    };
  },
});
