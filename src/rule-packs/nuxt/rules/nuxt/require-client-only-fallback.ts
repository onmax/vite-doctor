import type { RuleContext, TemplateElementNode } from "../../../../core/index.js";
import { TemplateNodeType } from "../../../../core/rule-authoring.js";
import { diagnostics } from "../../diagnostics.js";
import { createRule, isClientOnlyPath, isNuxtRuntimeFile } from "./shared.js";

const RULE_ID = "nuxt/hydration/require-clientonly-fallback";

const FALLBACK_PROPS = [
  "fallback",
  "placeholder",
  "fallback-tag",
  "fallbackTag",
  "placeholder-tag",
  "placeholderTag",
];

// Overlays render outside the layout, so an empty server placeholder does not move content.
const OVERLAY_TAG_RE =
  /^(?:teleport|Teleport|.*(?:Modal|Dialog|Drawer|Slideover|Toast|Toaster|Notifications)|.*-(?:modal|dialog|drawer|slideover|toast|toaster|notifications))$/;

export const requireClientOnlyFallback = createRule({
  meta: {
    id: RULE_ID,
    title: "Give ClientOnly a server fallback",
    category: "hydration",
    severity: "info",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/api/components/client-only",
    requires: { template: true, nuxt: true },
  },
  create(ctx) {
    if (
      !isNuxtRuntimeFile(ctx) ||
      isClientOnlyPath(ctx.file.relativePath) ||
      ctx.helpers.isNuxtServerFile(ctx.file.relativePath)
    )
      return;
    return {
      template: {
        element(node) {
          if (node.tag !== "ClientOnly" && node.tag !== "client-only") return;
          if (hasFallback(ctx.helpers, node) || rendersOnlyOverlays(node)) return;
          ctx.helpers.report(
            ctx,
            node,
            diagnostics.NUXT0086({
              why: "<ClientOnly> without a fallback renders an empty <span> on the server, so its content appears after hydration and moves the layout.",
              fix: "Add a #fallback slot with a placeholder of the same size, such as a skeleton, or a fallback-tag with classes that reserve the space.",
            }),
            { ruleId: RULE_ID, severity: ctx.severity, category: "hydration" },
          );
        },
      },
    };
  },
});

function hasFallback(helpers: RuleContext["helpers"], node: TemplateElementNode) {
  for (const name of FALLBACK_PROPS) {
    if (helpers.hasVueAttribute(node, name) || helpers.hasVueDirective(node, "bind", name))
      return true;
  }
  if (
    node.props.some(
      (prop) => prop.type === TemplateNodeType.DIRECTIVE && prop.name === "bind" && !prop.arg,
    )
  )
    return true;
  return node.children.some(
    (child) =>
      child.type === TemplateNodeType.ELEMENT &&
      child.tag === "template" &&
      (helpers.hasVueDirective(child, "slot", "fallback") ||
        helpers.hasVueDirective(child, "slot", "placeholder")),
  );
}

function rendersOnlyOverlays(node: TemplateElementNode) {
  const elements = node.children.filter((child) => child.type === TemplateNodeType.ELEMENT);
  return (
    elements.length > 0 &&
    elements.length ===
      node.children.filter(
        (child) => child.type !== TemplateNodeType.COMMENT && !isWhitespace(child),
      ).length &&
    elements.every((child) => OVERLAY_TAG_RE.test((child as TemplateElementNode).tag))
  );
}

function isWhitespace(node: { type: number; content?: unknown }) {
  return (
    node.type === TemplateNodeType.TEXT && typeof node.content === "string" && !node.content.trim()
  );
}
