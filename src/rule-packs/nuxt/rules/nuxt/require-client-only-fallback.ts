import type { RuleContext, TemplateElementNode } from "../../../../core/index.js";
import { TemplateNodeType } from "../../../../core/rule-authoring.js";
import { diagnostics } from "../../diagnostics.js";
import { createRule, isClientOnlyPath, isNuxtRuntimeFile } from "./shared.js";

const RULE_ID = "nuxt/hydration/require-clientonly-fallback";

const FALLBACK_TEXT_PROPS = ["fallback", "placeholder"];
const FALLBACK_TAG_PROPS = ["fallback-tag", "fallbackTag", "placeholder-tag", "placeholderTag"];
const FALLBACK_SLOTS = ["fallback", "placeholder"];

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
          if (!hasContent(node) || hasFallback(ctx.helpers, node) || rendersOnlyOverlays(node))
            return;
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
  for (const name of FALLBACK_TEXT_PROPS) {
    if (helpers.getStaticVueAttributeValue(node, name)?.trim()) return true;
    if (helpers.hasVueDirective(node, "bind", name)) return true;
  }
  for (const name of FALLBACK_TAG_PROPS) {
    if (helpers.hasVueAttribute(node, name) || helpers.hasVueDirective(node, "bind", name))
      return true;
  }
  if (FALLBACK_SLOTS.some((name) => helpers.hasVueDirective(node, "slot", name))) return true;
  // `v-bind="props"`, `:[name]` and `#[name]` can supply a fallback Doctor cannot see.
  if (hasUnknownArgument(node, "bind") || hasUnknownArgument(node, "slot")) return true;
  return node.children.some(
    (child) =>
      child.type === TemplateNodeType.ELEMENT &&
      child.tag === "template" &&
      (hasUnknownArgument(child, "slot") ||
        (hasContent(child) &&
          FALLBACK_SLOTS.some((name) => helpers.hasVueDirective(child, "slot", name)))),
  );
}

function hasUnknownArgument(node: TemplateElementNode, directive: "bind" | "slot") {
  return node.props.some((prop) => {
    if (prop.type !== TemplateNodeType.DIRECTIVE || prop.name !== directive) return false;
    // An argument-less v-bind spreads an object; an argument-less v-slot is the default slot.
    if (!prop.arg) return directive === "bind";
    return (prop.arg as { isStatic?: boolean }).isStatic !== true;
  });
}

function hasContent(node: TemplateElementNode) {
  return node.children.some(
    (child) => child.type !== TemplateNodeType.COMMENT && !isWhitespace(child),
  );
}

function rendersOnlyOverlays(node: TemplateElementNode): boolean {
  const rendered = node.children.filter(
    (child) => child.type !== TemplateNodeType.COMMENT && !isWhitespace(child),
  );
  return (
    rendered.length > 0 &&
    rendered.every((child) => {
      if (child.type !== TemplateNodeType.ELEMENT) return false;
      // A plain <template v-if> or v-for only groups its children.
      if (child.tag === "template") return rendersOnlyOverlays(child);
      return OVERLAY_TAG_RE.test(child.tag);
    })
  );
}

function isWhitespace(node: { type: number; content?: unknown }) {
  return (
    node.type === TemplateNodeType.TEXT && typeof node.content === "string" && !node.content.trim()
  );
}
