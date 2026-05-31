import type { RuleContext } from "../../../../core/index.js";
import { AnyNode, createRule, report } from "./shared.js";
import { asyncDataRuleOptions, getObjectPropertyValue, hasObjectProperty } from "./async-data.js";

export const previewModeGlobalRefresh = createRule({
  meta: {
    id: "nuxt/preview-mode-global-refresh",
    title: "Make preview mode refresh behavior explicit",
    category: "fetching",
    severity: "warn",
    fixable: "suggestion",
    docsUrl:
      "https://nuxt.com/docs/4.x/api/composables/use-preview-mode#customize-the-onenable-and-ondisable-callbacks",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    const options = asyncDataRuleOptions(ctx);
    const allowExplicitCallbacks =
      options.allowPreviewBroadEnablementWithExplicitCallbacks !== false;
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "usePreviewMode")) return;
        const previewOptions = node.arguments?.[0];
        if (previewOptions?.type !== "ObjectExpression") return;
        const hasExplicitCallbacks =
          hasObjectProperty(previewOptions, "onEnable") &&
          hasObjectProperty(previewOptions, "onDisable");
        if (hasExplicitCallbacks && allowExplicitCallbacks) return;
        const shouldEnable = getObjectPropertyValue(previewOptions, "shouldEnable");
        if (shouldEnable && !isBroadPreviewEnablement(ctx, shouldEnable)) return;
        report(
          ctx,
          node,
          "nuxt/preview-mode-global-refresh",
          "warn",
          "fetching",
          "usePreviewMode() can globally refresh Nuxt async data unless onEnable and onDisable are explicit.",
          "Add explicit callbacks that refresh only safe keys, or no-op callbacks when global refresh is not intended.",
        );
      },
    };
  },
});

function isBroadPreviewEnablement(ctx: RuleContext, node: AnyNode): boolean {
  const start = node.start ?? node.range?.[0];
  const end = node.end ?? node.range?.[1];
  const source =
    typeof start === "number" && typeof end === "number" ? ctx.file.text.slice(start, end) : "";
  return /import\.meta\.dev|\b(beta|staging)\b|=>\s*true\b|return\s+true\b/.test(source);
}
