import { join, resolve } from "pathe";
import type { RuleContext } from "../../../../core/index.js";
import { parseForESLint } from "../../../../core/internal/lazy-parsers.js";
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
      const expression =
        node.__doctorParent?.type === "ChainExpression" ? node.__doctorParent : node;
      const declarator = expression.__doctorParent;
      const declared =
        declarator?.type === "VariableDeclarator" &&
        declarator.init === expression &&
        declarator.id?.type === "Identifier"
          ? declarator.id.name
          : undefined;
      const defaultExport = expression.__doctorParent?.type === "ExportDefaultDeclaration";
      const composable =
        declared ??
        (defaultExport
          ? "default"
          : ctx.file.text
              .slice(Math.max(0, node.start - 120), node.start)
              .match(/use[A-Z]\w+/)?.[0]);
      if (composable && isRegistered(ctx, composable)) return;
      const exported =
        node.type === "CallExpression" &&
        (declared ? isExported(declarator, declared) : defaultExport);
      if (
        exported &&
        isNuxtFactoryBinding(ctx, node, name) &&
        SCANNED_EXTENSION_RE.test(ctx.file.path) &&
        inScannedComposablesDir(ctx)
      )
        return;
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

const SCANNED_EXTENSION_RE = /\.(?:[jt]sx?|[cm][jt]s)$/;

// Nuxt only injects keys into a registration's name imported from its source, so a same-named
// factory in another file stays unregistered.
function isRegistered(ctx: RuleContext, composable: string): boolean {
  const file = withoutExtension(ctx.file.path);
  return (ctx.project.nuxt?.manifest?.keyedComposables ?? []).some(
    (entry) =>
      entry.name === composable && (!entry.source || withoutExtension(entry.source) === file),
  );
}

function withoutExtension(path: string): string {
  return path.replace(/\.[^./]+$/, "");
}

// Nuxt's scan sees the transformed Nuxt auto-import, not an arbitrary local function
// or an import from another package. Keep this exemption conservative when scope parsing
// cannot establish the binding.
function isNuxtFactoryBinding(ctx: RuleContext, node: AnyNode, name: string): boolean {
  try {
    const parsed = parseForESLint(ctx.file.text, {
      range: true,
      sourceType: "module",
      ecmaVersion: "latest",
      filePath: ctx.file.path,
    });
    const callee = unwrapCallee(node.callee);
    const start = callee?.type === "Identifier" ? callee.start : undefined;
    if (start === undefined) return false;
    for (const scope of parsed.scopeManager.scopes) {
      for (const reference of scope.references) {
        if (reference.identifier.range?.[0] !== start) continue;
        const variable = reference.resolved;
        if (!variable) {
          const nuxt = ctx.project.nuxt;
          if (!nuxt?.autoImportsAuthoritative || !nuxt.autoImportEnabled) return false;
          const entry = nuxt.autoImports.get(name);
          return entry?.from === keyedFactorySource(name);
        }
        return variable.defs.some((definition: any) => {
          if (definition.type !== "ImportBinding") return false;
          const declaration = definition.parent;
          const source = String(declaration?.source?.value ?? "");
          const configured = ctx.project.nuxt?.autoImports.get(name)?.from;
          return source === "#imports" || (!!configured && source === configured);
        });
      }
    }
  } catch {
    // Recovered syntax has no reliable binding information; report conservatively.
  }
  return false;
}

function keyedFactorySource(name: string): string {
  return name === "createUseFetch" ? "#app/composables/fetch" : "#app/composables/asyncData";
}

function unwrapCallee(node: AnyNode): AnyNode {
  return node?.type === "ChainExpression" ? node.expression : node;
}

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
          specifier.exported?.type === "Identifier" &&
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
