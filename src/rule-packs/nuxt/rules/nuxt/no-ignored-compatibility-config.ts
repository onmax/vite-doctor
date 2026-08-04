import { type AnyNode, createRule } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

export const noIgnoredCompatibilityConfig = createRule({
  meta: {
    id: "nuxt/config/no-ignored-compatibility-config",
    title: "Remove config ignored by Nuxt compatibility 5",
    description: "Nuxt compatibility 5 ignores legacy unhead and error-data opt-outs.",
    why: "Nuxt compatibility 5 forces the new head and error-data behavior, so these legacy settings no longer change the runtime.",
    recommendedReplacement:
      "Remove unhead.legacy and experimental.parseErrorData, then update code for the Nuxt 5 behavior.",
    category: "migration",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/getting-started/upgrade",
    requires: { script: true, nuxt: true },
    applicability: { nuxtCompatibility: ">=5" },
  },
  create(ctx) {
    if (!/(^|\/)nuxt\.config\.[cm]?[jt]s$/.test(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Property") return;
        const key = propertyName(node);
        const parent = containingObjectProperty(node);
        if (!parent || !isExportedNuxtConfigObject(parent.__doctorParent)) return;
        const parentKey = propertyName(parent);
        const ignored =
          (parentKey === "unhead" && key === "legacy") ||
          (parentKey === "experimental" && key === "parseErrorData");
        if (!ignored) return;
        const path = `${parentKey}.${key}`;
        ctx.report(
          diagnostics.NUXT0073({
            why: `Nuxt compatibility 5 ignores ${path}.`,
            fix: `Remove ${path} and adopt the compatibility 5 behavior.`,
          }),
          {
            ruleId: "nuxt/config/no-ignored-compatibility-config",
            severity: "warn",
            category: "migration",
            file: ctx.file.path,
            range: ctx.range(node),
          },
        );
      },
    };
  },
});

function containingObjectProperty(node: AnyNode): AnyNode {
  const object = node.__doctorParent;
  if (object?.type !== "ObjectExpression") return null;
  const property = object.__doctorParent;
  return property?.type === "Property" ? property : null;
}

function isExportedNuxtConfigObject(node: AnyNode): boolean {
  if (node?.type !== "ObjectExpression") return false;
  let parent = unwrapParent(node.__doctorParent);
  if (parent?.type === "CallExpression" && parent.callee?.name === "defineNuxtConfig") {
    parent = unwrapParent(parent.__doctorParent);
  }
  return parent?.type === "ExportDefaultDeclaration";
}

function unwrapParent(node: AnyNode): AnyNode {
  let current = node;
  while (
    current &&
    ["TSAsExpression", "TSSatisfiesExpression", "ParenthesizedExpression"].includes(current.type)
  ) {
    current = current.__doctorParent;
  }
  return current;
}

function propertyName(node: AnyNode): string | null {
  if (node.key?.type === "Identifier") return node.key.name;
  if (typeof node.key?.value === "string") return node.key.value;
  return null;
}
