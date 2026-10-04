import { AnyNode, createRule, report } from "./shared.js";

const NON_EXECUTABLE_SCRIPT_TYPES = new Set([
  "application/importmap+json",
  "application/json",
  "application/ld+json",
  "importmap",
  "speculationrules",
]);

export const noUnsafeUseHeadScript = createRule({
  meta: {
    id: "nuxt/security/no-unsafe-usehead-script",
    title: "Avoid unsafe scripts in useHead",
    category: "security",
    severity: "error",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/api/composables/use-head-safe#usage",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "useHead")) return;
        if (!hasExecutableScriptHeadEntry(node.arguments?.[0])) return;
        report(
          ctx,
          node,
          "nuxt/security/no-unsafe-usehead-script",
          "error",
          "security",
          "Scripts injected through useHead can bypass safer metadata restrictions.",
          "Use Nuxt Scripts for third-party scripts or useHeadSafe() for constrained head values.",
        );
      },
    };
  },
});

function hasExecutableScriptHeadEntry(node: AnyNode): boolean {
  if (!node || typeof node !== "object") return false;
  if (
    [
      "ParenthesizedExpression",
      "TSAsExpression",
      "TSSatisfiesExpression",
      "TSTypeAssertion",
      "TSNonNullExpression",
    ].includes(node.type)
  )
    return hasExecutableScriptHeadEntry(node.expression);
  if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
    return node.body.type === "BlockStatement"
      ? returnedHead(node.body).hasScript
      : hasExecutableScriptHeadEntry(node.body);
  }
  if (node.type === "ConditionalExpression") {
    if (node.test.type === "Literal" && typeof node.test.value === "boolean")
      return hasExecutableScriptHeadEntry(node.test.value ? node.consequent : node.alternate);
    return (
      hasExecutableScriptHeadEntry(node.consequent) || hasExecutableScriptHeadEntry(node.alternate)
    );
  }
  if (node.type !== "ObjectExpression") return false;
  return (node.properties ?? []).some((property: AnyNode) => {
    if (property?.type !== "Property" || propertyKeyName(property) !== "script") return false;
    return hasExecutableScriptValue(property.value);
  });
}

function returnedHead(node: AnyNode): { hasScript: boolean; terminates: boolean } {
  const empty = { hasScript: false, terminates: false };
  if (!node) return empty;
  if (node.type === "ReturnStatement")
    return { hasScript: hasExecutableScriptHeadEntry(node.argument), terminates: true };
  if (node.type === "ThrowStatement") return { hasScript: false, terminates: true };
  if (node.type === "BlockStatement") {
    let hasScript = false;
    for (const statement of node.body) {
      const result = returnedHead(statement);
      hasScript ||= result.hasScript;
      if (result.terminates) return { hasScript, terminates: true };
    }
    return { hasScript, terminates: false };
  }
  if (node.type === "TryStatement") {
    const finalizer = returnedHead(node.finalizer);
    if (finalizer.terminates) return finalizer;
    const block = returnedHead(node.block);
    const handler = returnedHead(node.handler?.body);
    return {
      hasScript: finalizer.hasScript || block.hasScript || handler.hasScript,
      terminates: block.terminates && (!node.handler || handler.terminates),
    };
  }
  if (node.type === "IfStatement") {
    if (node.test.type === "Literal" && typeof node.test.value === "boolean")
      return returnedHead(node.test.value ? node.consequent : node.alternate);
    const consequent = returnedHead(node.consequent);
    const alternate = returnedHead(node.alternate);
    return {
      hasScript: consequent.hasScript || alternate.hasScript,
      terminates: consequent.terminates && alternate.terminates,
    };
  }
  return empty;
}

function hasExecutableScriptValue(node: AnyNode): boolean {
  if (!node || typeof node !== "object") return false;
  if (node.type === "ParenthesizedExpression") return hasExecutableScriptValue(node.expression);
  if (node.type === "ArrayExpression")
    return (node.elements ?? []).some((element: AnyNode) => hasExecutableScriptValue(element));
  if (node.type === "CallExpression" && calleePropertyName(node) === "map")
    return hasExecutableScriptValue(node.arguments?.[0]?.body);
  if (node.type !== "ObjectExpression") return true;
  const type = staticPropertyString(node, "type")?.toLowerCase();
  return !type || !NON_EXECUTABLE_SCRIPT_TYPES.has(type);
}

function staticPropertyString(node: AnyNode, name: string): string | null {
  for (const property of node.properties ?? []) {
    if (property?.type !== "Property" || propertyKeyName(property) !== name) continue;
    const value = property.value;
    if (value?.type === "Literal" && typeof value.value === "string") return value.value;
  }
  return null;
}

function calleePropertyName(node: AnyNode): string | null {
  const callee = node?.callee;
  return callee?.property?.name ?? callee?.property?.value ?? null;
}

function propertyKeyName(property: AnyNode): string | null {
  const key = property?.key;
  if (!key) return null;
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal") return String(key.value);
  return null;
}
