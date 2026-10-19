import { createRule } from "../../../core/index.js";
import { diagnostics } from "../../../diagnostics.js";
import {
  isViteConfigFile,
  memberPath,
  propertyName,
  staticString,
  type AnyNode,
} from "./shared.js";

const nodeSideImports = new Set(["vite", "vite-plus", "vitest/config"]);
const nodeUrlModules = new Set(["node:url", "url"]);
const functionTypes = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
]);

export const noUrlPathnameAsFsPath = createRule({
  meta: {
    id: "vite/config/no-url-pathname-as-fs-path",
    title: "Convert import.meta.url URLs with fileURLToPath",
    category: "config",
    severity: "warn",
    docsUrl: "https://nodejs.org/api/url.html#urlfileurltopathurl-options",
    requires: { script: true },
    prefilter: { names: ["pathname"] },
  },
  create(ctx) {
    let inScope = isViteConfigFile(ctx.file.relativePath);
    return {
      Program(node: AnyNode) {
        inScope ||= node.body.some(
          (statement: AnyNode) =>
            statement.type === "ImportDeclaration" &&
            nodeSideImports.has(String(statement.source.value)),
        );
      },
      "MemberExpression:exit"(node: AnyNode) {
        if (!inScope) return;
        const property = node.computed ? staticString(node.property) : propertyName(node.property);
        if (property !== "pathname") return;
        const object = unwrap(node.object);
        if (!isModuleFileUrl(object) && !isModuleFileUrlConst(object)) return;
        ctx.report(
          diagnostics.VITE0027({
            why: "URL.pathname keeps percent-encoding, such as %20 for spaces, and on Windows it returns /C:/... instead of a drive path, so the resolved file or alias target does not exist.",
            fix: 'Convert the URL with fileURLToPath(new URL(..., import.meta.url)) from "node:url".',
          }),
          { file: ctx.file.path, range: ctx.range(node) },
        );
      },
    };
  },
});

function isModuleFileUrl(input: AnyNode): boolean {
  const node = unwrap(input);
  if (node?.type !== "NewExpression" || node.callee.type !== "Identifier") return false;
  if (!isWhatwgUrl(node, node.callee.name)) return false;
  const base = node.arguments.length === 1 ? node.arguments[0] : node.arguments[1];
  return node.arguments.length <= 2 && memberPath(base) === "import.meta.url";
}

// The global URL, or URL imported from node:url under any local name.
function isWhatwgUrl(node: AnyNode, name: string): boolean {
  const binding = findBinding(node, name);
  if (!binding) return name === "URL";
  return (
    binding.type === "ImportDeclaration" &&
    nodeUrlModules.has(String(binding.source.value)) &&
    binding.specifiers.some(
      (specifier: AnyNode) =>
        specifier.local?.name === name &&
        specifier.type === "ImportSpecifier" &&
        (specifier.imported?.name ?? specifier.imported?.value) === "URL",
    )
  );
}

function isModuleFileUrlConst(node: AnyNode): boolean {
  if (node?.type !== "Identifier") return false;
  const binding = findBinding(node, node.name);
  return (
    binding?.type === "VariableDeclarator" &&
    binding.__doctorParent?.kind === "const" &&
    binding.id.type === "Identifier" &&
    isModuleFileUrl(binding.init)
  );
}

// The nearest declaration of `name` visible from `from`, or null for a global.
function findBinding(from: AnyNode, name: string): AnyNode {
  for (let current = from.__doctorParent; current; current = current.__doctorParent) {
    if (functionTypes.has(current.type)) {
      if (current.params.some((param: AnyNode) => bindsName(param, name))) return current;
      if (current.type === "FunctionExpression" && current.id?.name === name) return current;
      const hoisted = findVarBinding(current, name);
      if (hoisted) return hoisted;
    }
    if (current.type === "CatchClause" && bindsName(current.param, name)) return current;
    for (const statement of scopeStatements(current)) {
      const declaration =
        statement?.type === "ExportNamedDeclaration" ||
        statement?.type === "ExportDefaultDeclaration"
          ? statement.declaration
          : statement;
      if (declaration?.type === "VariableDeclaration") {
        const declarator = declaration.declarations.find((item: AnyNode) =>
          bindsName(item.id, name),
        );
        if (declarator) return declarator;
      }
      if (
        (declaration?.type === "FunctionDeclaration" || declaration?.type === "ClassDeclaration") &&
        declaration.id?.name === name
      )
        return declaration;
      if (
        declaration?.type === "ImportDeclaration" &&
        declaration.specifiers.some((specifier: AnyNode) => specifier.local?.name === name)
      )
        return declaration;
    }
  }
  return null;
}

// `var` declarations are scoped to the containing function, even when nested
// inside a conditional, loop, or try statement. Do not descend into nested
// functions, which introduce a separate var scope.
function findVarBinding(fn: AnyNode, name: string): AnyNode | null {
  let found: AnyNode | null = null;
  const visit = (node: AnyNode) => {
    if (!node || found) return;
    if (node !== fn && functionTypes.has(node.type)) return;
    if (node.type === "VariableDeclaration" && node.kind === "var") {
      const declarator = node.declarations.find((item: AnyNode) => bindsName(item.id, name));
      if (declarator) {
        found = declarator;
        return;
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "__doctorParent" || key === "parent") continue;
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child === "object") visit(child as AnyNode);
      } else if (value && typeof value === "object") visit(value as AnyNode);
      if (found) return;
    }
  };
  visit(fn.body);
  return found;
}

function scopeStatements(node: AnyNode): AnyNode[] {
  if (node.type === "Program" || node.type === "BlockStatement" || node.type === "StaticBlock")
    return node.body;
  if (node.type === "SwitchStatement")
    return node.cases.flatMap((item: AnyNode) => item.consequent);
  if (node.type === "ForStatement") return [node.init];
  if (node.type === "ForInStatement" || node.type === "ForOfStatement") return [node.left];
  return [];
}

function bindsName(pattern: AnyNode, name: string): boolean {
  if (pattern?.type === "Identifier") return pattern.name === name;
  if (pattern?.type === "AssignmentPattern") return bindsName(pattern.left, name);
  if (pattern?.type === "RestElement") return bindsName(pattern.argument, name);
  if (pattern?.type === "TSParameterProperty") return bindsName(pattern.parameter, name);
  if (pattern?.type === "ArrayPattern")
    return pattern.elements.some((item: AnyNode) => bindsName(item, name));
  if (pattern?.type === "ObjectPattern")
    return pattern.properties.some((item: AnyNode) => bindsName(item.value ?? item.argument, name));
  return false;
}

function unwrap(node: AnyNode): AnyNode {
  while (
    node &&
    [
      "TSAsExpression",
      "TSTypeAssertion",
      "TSSatisfiesExpression",
      "TSNonNullExpression",
      "ParenthesizedExpression",
      "ChainExpression",
    ].includes(node.type)
  )
    node = node.expression;
  return node;
}
