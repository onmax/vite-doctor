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
  if (!node || typeof node !== "object" || node.type !== "ObjectExpression") return false;
  return (node.properties ?? []).some((property: AnyNode) => {
    if (property?.type !== "Property" || propertyKeyName(property) !== "script") return false;
    return hasExecutableScriptValue(property.value);
  });
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
