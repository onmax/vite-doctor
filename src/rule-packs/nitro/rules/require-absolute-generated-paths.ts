import { isAbsolute, relative, resolve } from "pathe";
import type { RuleContext } from "../../../core/index.js";
import { nitroServerFile } from "./server-layout.js";
import { createRule, isNitroServerFile, report, sourceForNode, type AnyNode } from "./shared.js";

const RULE_ID = "nitro/config/require-absolute-generated-paths";
const NUXT_KIT_SOURCES = new Set(["@nuxt/kit", "nuxt/kit"]);

// Files that register Nitro handlers for someone else: Vite plugins, Nuxt modules, Nitro modules.
const INTEGRATION_SOURCES = new Set([
  "vite",
  "nitro",
  "nitropack",
  "nitro/kit",
  "nitropack/kit",
  "nitro/types",
  "nitropack/types",
  ...NUXT_KIT_SOURCES,
  "@nuxt/schema",
]);

const HANDLER_SHAPE_KEYS = new Set(["route", "middleware", "method", "lazy"]);
const CONFIG_FILE_RE = /(?:^|\/)(?:nuxt|nitro|vite|vitest|app)\.config\.[cm]?[jt]s$/;
const TEST_FILE_RE = /(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
// App and server runtime directories, relative to the workspace package that owns the file.
const RUNTIME_DIR_RE =
  /^(?:app\/)?(?:api|components|composables|layouts|middleware|pages|plugins|routes|server)\//;

export const requireAbsoluteGeneratedPaths = createRule({
  meta: {
    id: RULE_ID,
    title: "Register Nitro handlers and plugins with absolute paths",
    category: "modules",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://nitro.build/config#handlers",
    requires: { script: true },
    prefilter: { names: ["handler", "plugins"] },
  },
  create(ctx) {
    const path = ctx.file.relativePath.replace(/\\/g, "/");
    if (CONFIG_FILE_RE.test(path) || TEST_FILE_RE.test(path)) return;
    if (isRuntimeFile(ctx, path)) return;
    let integration = false;
    const kitFunctions = new Set<string>();
    const kitNamespaces = new Set<string>();
    const strings = new Map<string, AnyNode>();
    const declarations = new Map<string, number>();
    const declare = (name: string) => declarations.set(name, (declarations.get(name) ?? 0) + 1);
    const declareParameters = (node: AnyNode) => {
      for (const parameter of node.params ?? [])
        if (parameter.type === "Identifier") declare(parameter.name);
    };
    const candidates: Array<{ node: AnyNode; kind: "handler" | "plugin" }> = [];
    return {
      ImportDeclaration(node: AnyNode) {
        const source = String(node.source?.value);
        if (INTEGRATION_SOURCES.has(source)) integration = true;
        if (!NUXT_KIT_SOURCES.has(source)) return;
        for (const specifier of node.specifiers ?? []) {
          if (specifier.type === "ImportSpecifier") kitFunctions.add(specifier.local.name);
          if (specifier.type === "ImportNamespaceSpecifier")
            kitNamespaces.add(specifier.local.name);
        }
      },
      VariableDeclarator(node: AnyNode) {
        if (node.id?.type !== "Identifier") return;
        declare(node.id.name);
        if (node.__doctorParent?.kind !== "const") return;
        const value = unwrapExpression(node.init);
        if (staticStringValue(value) !== undefined) strings.set(node.id.name, value);
      },
      FunctionDeclaration: declareParameters,
      FunctionExpression: declareParameters,
      ArrowFunctionExpression: declareParameters,
      ObjectExpression(node: AnyNode) {
        const handler = node.properties?.find(
          (property: AnyNode) => propertyKeyName(property) === "handler",
        );
        if (!handler) return;
        if (
          !node.properties.some((property: AnyNode) =>
            HANDLER_SHAPE_KEYS.has(propertyKeyName(property) ?? ""),
          )
        )
          return;
        if (isKitHelperArgument(node, kitFunctions, kitNamespaces)) return;
        candidates.push({ node: handler.value, kind: "handler" });
      },
      CallExpression(node: AnyNode) {
        const callee = unwrapExpression(node.callee);
        if (callee?.type !== "MemberExpression" || callee.computed) return;
        if (callee.property?.name !== "push" && callee.property?.name !== "unshift") return;
        const target = unwrapExpression(callee.object);
        if (target?.type !== "MemberExpression" || target.property?.name !== "plugins") return;
        if (!isNitroOptions(target.object)) return;
        for (const argument of node.arguments ?? [])
          candidates.push({ node: argument, kind: "plugin" });
      },
      AssignmentExpression(node: AnyNode) {
        const target = unwrapExpression(node.left);
        const value = unwrapExpression(node.right);
        if (target?.type !== "MemberExpression" || target.computed) return;
        if (target.property?.name !== "plugins" || value?.type !== "ArrayExpression") return;
        if (!isNitroOptions(target.object)) return;
        for (const element of value.elements ?? [])
          candidates.push({ node: element, kind: "plugin" });
      },
      Property(node: AnyNode) {
        if (
          propertyKeyName(node) !== "plugins" ||
          unwrapExpression(node.value)?.type !== "ArrayExpression"
        )
          return;
        const owner = node.__doctorParent?.__doctorParent;
        if (owner?.type !== "Property" || propertyKeyName(owner) !== "nitro") return;
        for (const element of unwrapExpression(node.value).elements ?? [])
          candidates.push({ node: element, kind: "plugin" });
      },
      "Program:exit"() {
        if (!integration) return;
        for (const { node, kind } of candidates) {
          const value = unwrapExpression(node);
          // A name declared more than once may resolve to another scope's value, so skip it.
          const literal =
            value?.type === "Identifier"
              ? declarations.get(value.name) === 1
                ? strings.get(value.name)
                : undefined
              : staticStringValue(value) !== undefined
                ? value
                : undefined;
          const text = staticStringValue(literal);
          if (text === undefined || !isRelativeFilePath(text)) continue;
          reportPath(ctx, value, text, kind);
        }
      },
    };
  },
});

function reportPath(ctx: RuleContext, node: AnyNode, text: string, kind: "handler" | "plugin") {
  const raw = sourceForNode(node, ctx.file.text);
  const base =
    kind === "plugin"
      ? "Nitro resolves plugin paths against srcDir (Nitro 2) or rootDir (Nitro 3)"
      : "Nitro 3 resolves handler paths against rootDir, and Nitro 2 imports them as written";
  report(
    ctx,
    node,
    RULE_ID,
    ctx.severity,
    "modules",
    `This Nitro ${kind} is registered with the relative path ${JSON.stringify(text)}. ${base}, not against this file or the directory the file was written to, so the path breaks when those differ.`,
    `Register an absolute path: resolve it from the same root you write the file to, such as resolve(root, ${raw}), or from this package with createResolver(import.meta.url).resolve(${raw}).`,
  );
}

function isRuntimeFile(ctx: RuleContext, path: string) {
  if (RUNTIME_DIR_RE.test(packageRelativePath(ctx, path)) || isNitroServerFile(ctx)) return true;
  if (ctx.project.framework !== "nuxt") return false;
  // Configured Nuxt serverDir, srcDir and appDir move runtime code away from the default paths.
  const file = resolve(ctx.project.root, ctx.file.path);
  if (nitroServerFile(ctx, file)) return true;
  const appDir = ctx.project.nuxt?.appDir;
  return Boolean(appDir && appDir !== ctx.project.root && isInside(appDir, file));
}

function isInside(directory: string, file: string) {
  const path = relative(directory, file);
  return Boolean(path) && !path.startsWith("../") && !isAbsolute(path);
}

function packageRelativePath(ctx: RuleContext, path: string) {
  let owner = "";
  for (const item of ctx.project.workspacePackages ?? []) {
    const root = item.root === "." ? "" : `${item.root.replace(/\\/g, "/")}/`;
    if (root.length > owner.length && path.startsWith(root)) owner = root;
  }
  return path.slice(owner.length);
}

function isRelativeFilePath(value: string) {
  return value.startsWith("./") || value.startsWith("../") || /^\.[\w-]+[\\/]/.test(value);
}

const EXPRESSION_WRAPPERS = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
]);

function unwrapExpression(node: AnyNode): AnyNode {
  let current = node;
  while (EXPRESSION_WRAPPERS.has(current?.type)) current = current.expression;
  return current;
}

function staticStringValue(node: AnyNode): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && !node.expressions?.length && node.quasis?.length === 1)
    return node.quasis[0].value?.cooked ?? node.quasis[0].value?.raw;
  return undefined;
}

function propertyKeyName(property: AnyNode): string | undefined {
  if (property?.type !== "Property" || property.computed) return undefined;
  if (property.key?.type === "Identifier") return property.key.name;
  return staticStringValue(property.key);
}

function isKitHelperArgument(node: AnyNode, kitFunctions: Set<string>, kitNamespaces: Set<string>) {
  let parent = outerExpression(node).__doctorParent;
  if (parent?.type === "ArrayExpression") parent = outerExpression(parent).__doctorParent;
  if (parent?.type !== "CallExpression") return false;
  const callee = unwrapExpression(parent.callee);
  if (callee?.type === "Identifier") return kitFunctions.has(callee.name);
  return (
    callee?.type === "MemberExpression" &&
    callee.object?.type === "Identifier" &&
    kitNamespaces.has(callee.object.name)
  );
}

function outerExpression(node: AnyNode): AnyNode {
  let current = node;
  while (EXPRESSION_WRAPPERS.has(current.__doctorParent?.type)) current = current.__doctorParent;
  return current;
}

function isNitroOptions(node: AnyNode): boolean {
  for (let current = unwrapExpression(node); current; current = unwrapExpression(current.object)) {
    const name = current.type === "MemberExpression" ? current.property?.name : current.name;
    if (typeof name === "string" && /nitro/i.test(name)) return true;
    if (current.type !== "MemberExpression") return isNitroConfigHookParameter(current);
  }
  return false;
}

function isNitroConfigHookParameter(identifier: AnyNode): boolean {
  if (identifier?.type !== "Identifier") return false;
  for (let current = identifier.__doctorParent; current; current = current.__doctorParent) {
    if (
      (current.type === "ArrowFunctionExpression" || current.type === "FunctionExpression") &&
      current.params?.[0]?.type === "Identifier" &&
      current.params[0].name === identifier.name
    ) {
      const call = current.__doctorParent;
      return (
        call?.type === "CallExpression" &&
        call.arguments?.[1] === current &&
        staticStringValue(call.arguments[0]) === "nitro:config"
      );
    }
  }
  return false;
}
