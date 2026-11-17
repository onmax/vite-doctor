import { AnyNode, createRule, report } from "./shared.js";

const SEO_META_NAMES = /^(?:description$|og:|twitter:)/i;

export const preferSeoComposables = createRule({
  meta: {
    id: "nuxt/seo/prefer-seo-composables",
    title: "Use Nuxt SEO composables for metadata",
    category: "seo",
    severity: "warn",
    confidence: "heuristic-high",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/api/composables/use-seo-meta#usage",
    requires: { script: true, nuxt: true },
    prefilter: { calls: ["useHead"] },
  },
  create(ctx) {
    return {
      CallExpression(node: AnyNode) {
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

// useSeoMeta() owns the title, the description, and Open Graph and Twitter tags. Everything else in
// useHead() (links, html attributes, a title template, viewport or charset meta) stays there.
function hasSeoHeadMetadata(node: AnyNode): boolean {
  if (node?.type !== "ObjectExpression") return false;
  let title = false;
  let needsUseHead = false;
  for (const property of node.properties ?? []) {
    if (property.type !== "Property") {
      needsUseHead = true;
      continue;
    }
    const key = staticPropertyKey(property);
    if (key === "meta") {
      const meta = metaEntries(property.value);
      if (meta.some(isSeoMetaEntry)) return true;
      if (meta.length || !isEmptyArray(property.value)) needsUseHead = true;
    } else if (key === "title") title = true;
    else needsUseHead = true;
  }
  return title && !needsUseHead;
}

/** Literal meta entries, including both branches of a conditional or logical expression. */
function metaEntries(node: AnyNode): AnyNode[] {
  if (node?.type === "ArrayExpression") return (node.elements ?? []).filter(Boolean);
  if (node?.type === "ConditionalExpression")
    return [...metaEntries(node.consequent), ...metaEntries(node.alternate)];
  if (node?.type === "LogicalExpression")
    return [...metaEntries(node.left), ...metaEntries(node.right)];
  return [];
}

function isEmptyArray(node: AnyNode): boolean {
  return node?.type === "ArrayExpression" && !(node.elements ?? []).length;
}

function isSeoMetaEntry(entry: AnyNode): boolean {
  if (entry?.type !== "ObjectExpression") return false;
  const name = getStaticMetaName(entry);
  return Boolean(name && SEO_META_NAMES.test(name));
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
