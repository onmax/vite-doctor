import type { TemplateAttributeNode, TemplateElementNode } from "../../../../core/index.js";
import { findTemplateAttribute } from "../../../../core/rule-authoring.js";
import { createRule } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "nuxt/routing/prefer-nuxtlink";

export const preferNuxtLink = createRule({
  meta: {
    id: "nuxt/routing/prefer-nuxtlink",
    title: "Use NuxtLink for internal navigation",
    category: "routing",
    severity: "warn",
    fixable: "safe",
    docsUrl: "https://nuxt.com/docs/4.x/api/components/nuxt-link#nuxtlink",
    requires: { template: true, nuxt: true },
  },
  create(ctx) {
    return {
      template: {
        element(node) {
          if (node.tag !== "a") return;
          if (findTemplateAttribute(node, "target") || findTemplateAttribute(node, "download"))
            return;

          const href = findTemplateAttribute(node, "href");
          const hrefValue = href?.value?.content;
          if (!href || hrefValue === undefined || !isInternalNavigationHref(hrefValue)) return;

          ctx.report(
            diagnostics.NUXT0050({
              why: "Raw <a> tags skip NuxtLink routing behavior for internal navigation.",
              fix: "Use <NuxtLink> with a to prop for internal app links.",
            }),
            {
              ruleId: RULE_ID,
              severity: "warn",
              category: "routing",
              file: ctx.file.path,
              range: ctx.range(node),
              fix: staticNuxtLinkFix(ctx.file.text, node, href),
            },
          );
        },
      },
    };
  },
});

function isInternalNavigationHref(value: string) {
  return (
    (value.startsWith("/") && !value.startsWith("//")) ||
    value.startsWith("./") ||
    value.startsWith("../")
  );
}

function staticNuxtLinkFix(text: string, node: TemplateElementNode, href: TemplateAttributeNode) {
  const start = node.loc.start.offset;
  const end = node.loc.end.offset;
  const hrefStart = href.nameLoc.start.offset;
  const hrefEnd = href.nameLoc.end.offset;
  const snippet = text.slice(start, end);
  const replacement = `${text.slice(start, hrefStart)}to${text.slice(hrefEnd, end)}`
    .replace(/^<a\b/, "<NuxtLink")
    .replace(/<\/a\s*>$/, "</NuxtLink>");

  if (replacement === snippet) return null;
  return {
    kind: "safe" as const,
    edits: [{ range: { start, end }, text: replacement }],
  };
}
