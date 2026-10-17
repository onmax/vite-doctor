import { join } from "pathe";
import type { RuleContext } from "../../../../core/index.js";
import { AnyNode, createRule, report } from "./shared.js";

export const keyedComposableRegistrationRequired = createRule({
  meta: {
    id: "nuxt/fetch/keyed-composable-registration-required",
    title: "Register custom keyed data composables",
    category: "fetching",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/api/composables/create-use-fetch#usage",
    requires: { script: true, nuxt: true },
    prefilter: { names: ["createUseFetch", "createUseAsyncData"] },
  },
  create(ctx) {
    const visit = (node: AnyNode) => {
      const name = ctx.helpers.getCalleeName(node);
      if (name !== "createUseFetch" && name !== "createUseAsyncData") return;
      const declarator = node.__doctorParent;
      const declared =
        declarator?.type === "VariableDeclarator" &&
        declarator.init === node &&
        declarator.id?.type === "Identifier"
          ? declarator.id.name
          : undefined;
      const composable =
        declared ??
        ctx.file.text.slice(Math.max(0, node.start - 120), node.start).match(/use[A-Z]\w+/)?.[0];
      if (composable && ctx.project.nuxt?.manifest?.keyedComposables.includes(composable)) return;
      if (declared && isExported(declarator) && inScannedComposablesDir(ctx)) return;
      report(
        ctx,
        node,
        "nuxt/fetch/keyed-composable-registration-required",
        "warn",
        "fetching",
        "Custom data factory composables should be registered for key injection.",
        "Add the composable name to Nuxt keyed composables configuration when it is not auto-detected.",
      );
    };
    return { CallExpression: visit, NewExpression: visit };
  },
});

function isExported(declarator: AnyNode): boolean {
  const declaration = declarator.__doctorParent;
  return (
    declaration?.type === "VariableDeclaration" &&
    declaration.__doctorParent?.type === "ExportNamedDeclaration"
  );
}

// Nuxt's compiler scan registers factories exported from every layer's `composables/` tree.
function inScannedComposablesDir(ctx: RuleContext): boolean {
  const nuxt = ctx.project.nuxt;
  if (ctx.file.inAppDir("composables")) {
    const appLayer = nuxt?.layers?.find(
      (layer) => layer.root === nuxt.appDir || layer.srcDir === nuxt.appDir,
    );
    return appLayer ? appLayer.compilerScan !== false : true;
  }
  return (nuxt?.layers ?? []).some(
    (layer) =>
      layer.compilerScan !== false &&
      layer.srcDir &&
      ctx.file.path.startsWith(`${join(layer.srcDir, "composables")}/`),
  );
}
