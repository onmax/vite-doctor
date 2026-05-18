import { AnyNode, createRule, getElementName } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "nuxt/routing/prefer-nuxtlink";

export const preferNuxtLink = createRule({
  meta: {
    id: "nuxt/routing/prefer-nuxtlink",
    title: "Use NuxtLink for internal navigation",
    category: "routing",
    severity: "warn",
    fixable: "safe",
    requires: { template: true, nuxt: true },
  },
  create(ctx) {
    return {
      TemplateNode(node: AnyNode) {
        if (node.type !== "VElement" || getElementName(node) !== "a") return;
        if (hasStaticAttr(node, "target") || hasStaticAttr(node, "download")) return;

        const href = getStaticAttrNode(node, "href");
        const hrefValue = href?.value?.value;
        if (typeof hrefValue !== "string" || !isInternalNavigationHref(hrefValue)) return;

        ctx.report(
          diagnostics.NUXT0050.report({
            why: "Raw <a> tags skip NuxtLink routing behavior for internal navigation.",
            fix: "Use <NuxtLink> with a to prop for internal app links.",
          }),
          {
            ruleId: RULE_ID,
            severity: "warn",
            category: "routing",
            file: ctx.file.path,
            range: ctx.range(node),
            fix: staticNuxtLinkFix(ctx.file.text, node),
          },
        );
      },
    };
  },
});

function getStaticAttrNode(node: AnyNode, name: string) {
  return (node.startTag?.attributes ?? []).find(
    (attr: AnyNode) => !attr.directive && attr.key?.name === name,
  );
}

function hasStaticAttr(node: AnyNode, name: string) {
  return Boolean(getStaticAttrNode(node, name));
}

function isInternalNavigationHref(value: string) {
  return (
    (value.startsWith("/") && !value.startsWith("//")) ||
    value.startsWith("./") ||
    value.startsWith("../")
  );
}

function staticNuxtLinkFix(text: string, node: AnyNode) {
  const start = node.start ?? node.range?.[0];
  const end = node.end ?? node.range?.[1];
  if (typeof start !== "number" || typeof end !== "number") return null;

  const snippet = text.slice(start, end);
  const replacement = snippet
    .replace(/^<a\b/, "<NuxtLink")
    .replace(/(\s)href(\s*=)/, "$1to$2")
    .replace(/<\/a\s*>$/, "</NuxtLink>");

  if (replacement === snippet) return null;
  return {
    kind: "safe" as const,
    edits: [{ range: { start, end }, text: replacement }],
  };
}
