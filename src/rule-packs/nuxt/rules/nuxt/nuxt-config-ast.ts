import type { AnyNode } from "./shared.js";

const WRAPPER_TYPES = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "ParenthesizedExpression",
]);
export const ENVIRONMENT_OVERRIDE_KEYS = new Set(["$production", "$development", "$test"]);
export const FUNCTION_TYPES = new Set([
  "FunctionExpression",
  "ArrowFunctionExpression",
  "FunctionDeclaration",
]);

export function topLevelBindings(program: AnyNode): Map<string, AnyNode> {
  const bindings = new Map<string, AnyNode>();
  for (const statement of program.body ?? []) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations) {
        if (declarator.id?.type === "Identifier" && declarator.init) {
          bindings.set(declarator.id.name, declarator.init);
        }
      }
    } else if (declaration?.type === "FunctionDeclaration" && declaration.id?.name) {
      bindings.set(declaration.id.name, declaration);
    }
  }
  return bindings;
}

export function exportedConfigObject(program: AnyNode, bindings: Map<string, AnyNode>): AnyNode {
  const exported = program.body?.find(
    (statement: AnyNode) => statement.type === "ExportDefaultDeclaration",
  )?.declaration;
  let config = unwrap(exported);
  if (config?.type === "Identifier" && isDefineNuxtConfig(unwrap(bindings.get(config.name)))) {
    config = unwrap(bindings.get(config.name));
  }
  if (isDefineNuxtConfig(config)) {
    config = unwrap(config.arguments?.[0]);
  }
  return objectExpression(config, bindings);
}

function isDefineNuxtConfig(node: AnyNode): boolean {
  return node?.type === "CallExpression" && node.callee?.name === "defineNuxtConfig";
}

export function objectExpression(node: AnyNode, bindings: Map<string, AnyNode>): AnyNode {
  const value = unwrap(node);
  if (value?.type === "ObjectExpression") return value;
  if (value?.type === "Identifier") {
    const bound = unwrap(bindings.get(value.name));
    if (bound?.type === "ObjectExpression") return bound;
  }
  return null;
}

// Visits what runs while nuxt.config loads: nested functions are visited but not entered, because
// their bodies run only when something calls them later.
export function walkWhileLoading(root: AnyNode, visit: (node: AnyNode) => void) {
  const step = (node: AnyNode, nested: boolean) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) step(child, true);
      return;
    }
    if (typeof node.type === "string") {
      visit(node);
      if (nested && FUNCTION_TYPES.has(node.type)) return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== "__doctorParent") step(value, true);
    }
  };
  step(root, false);
}

export function declaredNames(fn: AnyNode): Set<string> {
  const names = new Set<string>();
  for (const param of fn.params ?? []) patternNames(param, names);
  walkWhileLoading(fn.body, (node) => {
    if (node.type === "VariableDeclarator") patternNames(node.id, names);
    else if (node.type === "FunctionDeclaration" && node.id?.name) names.add(node.id.name);
  });
  return names;
}

function patternNames(pattern: AnyNode, names: Set<string>) {
  switch (pattern?.type) {
    case "Identifier":
      names.add(pattern.name);
      break;
    case "AssignmentPattern":
      patternNames(pattern.left, names);
      break;
    case "RestElement":
      patternNames(pattern.argument, names);
      break;
    case "TSParameterProperty":
      patternNames(pattern.parameter, names);
      break;
    case "ArrayPattern":
      for (const element of pattern.elements ?? []) patternNames(element, names);
      break;
    case "ObjectPattern":
      for (const property of pattern.properties ?? []) {
        patternNames(property.type === "RestElement" ? property : property.value, names);
      }
      break;
  }
}

export function isCallee(node: AnyNode): boolean {
  const parent = node.__doctorParent;
  return parent?.type === "CallExpression" && parent.callee === node;
}

export function isNonReference(node: AnyNode): boolean {
  const parent = node.__doctorParent;
  if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) {
    return true;
  }
  if (parent?.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand) {
    return true;
  }
  return false;
}

export function propertyName(property: AnyNode): string | null {
  const key = property.key;
  if (!property.computed && key?.type === "Identifier") return key.name;
  if (key?.type === "Literal" && typeof key.value === "string") return key.value;
  if (key?.type === "TemplateLiteral" && key.expressions.length === 0) {
    return key.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

export function unwrap(node: AnyNode): AnyNode {
  let current = node;
  while (current && WRAPPER_TYPES.has(current.type)) current = current.expression;
  return current;
}

/**
 * What turns on experimental.buildCache for a production build: the resolved manifest flag when
 * it is current, else a literal `true` in nuxt.config. A computed flag returns null.
 */
export function buildCacheSource(
  resolved: boolean | undefined,
  config: AnyNode,
  bindings: Map<string, AnyNode>,
): "manifest" | "config" | null {
  if (resolved !== undefined) return resolved ? "manifest" : null;
  // c12 shallowly combines the environment blocks, then merges them over the root.
  const production = objectExpression(propertyValue(config, "$production"), bindings);
  const env = objectExpression(propertyValue(config, "$env"), bindings);
  const envProduction = objectExpression(propertyValue(env, "production"), bindings);
  const override =
    propertyValue(envProduction, "experimental") ?? propertyValue(production, "experimental");
  if (override) {
    const experimental = objectExpression(override, bindings);
    if (!experimental) return null;
    const flag = unwrap(propertyValue(experimental, "buildCache"));
    if (flag) return flag.type === "Literal" && flag.value === true ? "config" : null;
  }
  const experimental = objectExpression(propertyValue(config, "experimental"), bindings);
  const flag = unwrap(propertyValue(experimental, "buildCache"));
  return flag?.type === "Literal" && flag.value === true ? "config" : null;
}

export function propertyValue(node: AnyNode, name: string): AnyNode {
  for (const property of node?.properties ?? []) {
    if (property.type === "Property" && propertyName(property) === name) return property.value;
  }
  return null;
}
