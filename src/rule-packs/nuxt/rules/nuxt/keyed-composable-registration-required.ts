import { join, resolve } from "pathe";
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
      const exported = declared
        ? isExported(declarator, declared)
        : node.__doctorParent?.type === "ExportDefaultDeclaration";
      if (exported && inScannedComposablesDir(ctx)) return;
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

// Mirrors the export shapes Nuxt's keyed-function-factories scan accepts.
function isExported(declarator: AnyNode, name: string): boolean {
  const declaration = declarator.__doctorParent;
  if (declaration?.type !== "VariableDeclaration") return false;
  const parent = declaration.__doctorParent;
  if (parent?.type === "ExportNamedDeclaration") return true;
  if (parent?.type !== "Program") return false;
  return parent.body.some(
    (statement: AnyNode) =>
      statement.type === "ExportNamedDeclaration" &&
      !statement.source &&
      statement.exportKind !== "type" &&
      statement.specifiers?.some(
        (specifier: AnyNode) =>
          specifier.type === "ExportSpecifier" &&
          specifier.exportKind !== "type" &&
          specifier.local?.type === "Identifier" &&
          specifier.local.name === name,
      ),
  );
}

// Nuxt's compiler scan registers factories exported from every layer's `composables/` tree.
function inScannedComposablesDir(ctx: RuleContext): boolean {
  const nuxt = ctx.project.nuxt;
  const root = ctx.project.root;
  const layers = (nuxt?.layers ?? []).map((layer) => ({
    root: resolve(root, layer.root),
    srcDir: layer.srcDir ? resolve(root, layer.srcDir) : undefined,
    compilerScan: layer.compilerScan,
  }));
  if (ctx.file.inAppDir("composables")) {
    const appLayer = layers.find(
      (layer) => layer.root === nuxt?.appDir || layer.srcDir === nuxt?.appDir,
    );
    return appLayer ? appLayer.compilerScan !== false : true;
  }
  return layers.some(
    (layer) =>
      layer.compilerScan !== false &&
      layer.srcDir &&
      ctx.file.path.startsWith(`${join(layer.srcDir, "composables")}/`),
  );
}
