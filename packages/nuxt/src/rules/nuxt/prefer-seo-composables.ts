import { AnyNode, createRule, report } from "./shared.js";

const SEO_HEAD_KEYS = new Set(["title", "titleTemplate"]);
const SEO_META_NAMES =
  /^(description|keywords|author|robots|og:|twitter:|article:|book:|profile:)/i;
const NON_SEO_META_NAMES = new Set(["charset", "viewport", "theme-color", "color-scheme"]);

export const preferSeoComposables = createRule({
  meta: {
    id: "nuxt/seo/prefer-seo-composables",
    title: "Use Nuxt SEO composables for metadata",
    category: "seo",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "useHead")) return;
        if (!hasSeoHeadMetadata(node.arguments?.[0])) return;
        report(
          ctx,
          node,
          "nuxt/seo/prefer-seo-composables",
          "warn",
          "seo",
          "SEO metadata is safer and better typed through Nuxt SEO composables.",
          "Use useSeoMeta() for SEO metadata and useHeadSafe() for untrusted values.",
        );
      },
    };
  },
});

function hasSeoHeadMetadata(node: AnyNode): boolean {
  if (node?.type !== "ObjectExpression") return false;
  for (const property of node.properties ?? []) {
    if (property.type !== "Property") continue;
    const key = staticPropertyKey(property);
    if (key && SEO_HEAD_KEYS.has(key)) return true;
    if (key === "meta" && hasSeoMetaProperty(property.value)) return true;
  }
  return false;
}

function hasSeoMetaProperty(node: AnyNode): boolean {
  if (node?.type !== "ArrayExpression") return true;
  for (const element of node.elements ?? []) {
    if (!element) continue;
    if (element.type !== "ObjectExpression") return true;
    const name = getStaticMetaName(element);
    if (!name) return true;
    if (!NON_SEO_META_NAMES.has(name.toLowerCase()) && SEO_META_NAMES.test(name)) return true;
  }
  return false;
}

function getStaticMetaName(node: AnyNode): string | undefined {
  for (const property of node.properties ?? []) {
    if (property.type !== "Property") continue;
    const key = staticPropertyKey(property);
    if (key !== "name" && key !== "property" && key !== "charset") continue;
    if (key === "charset") return "charset";
    const value = property.value;
    if (value?.type === "Literal" || value?.type === "StringLiteral") return String(value.value);
  }
}

function staticPropertyKey(property: AnyNode): string | undefined {
  const key = property.key;
  if (!key) return;
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal" || key.type === "StringLiteral") return String(key.value);
}
