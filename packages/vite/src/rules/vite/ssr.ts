import { createRule } from "@vue-doctor/core";
import { isLikelySsrFile, type AnyNode } from "./shared.js";

export const noBrowserGlobalInSsrEntry = createRule({
  meta: {
    id: "vite/ssr/no-browser-global-in-ssr-entry",
    title: "Avoid browser globals in Vite SSR entries",
    category: "ssr",
    severity: "error",
    requires: { script: true },
  },
  create(ctx) {
    if (!isLikelySsrFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Identifier" || !browserGlobals.has(node.name)) return;
        if (
          ctx.helpers.isTypeofOperand(node) ||
          ctx.helpers.hasLocalBindingBefore(node, ctx.file.text)
        )
          return;
        ctx.report({
          ruleId: "vite/ssr/no-browser-global-in-ssr-entry",
          severity: ctx.severity,
          category: "ssr",
          file: ctx.file.path,
          range: ctx.range(node),
          message: `Vite SSR entry "${ctx.file.relativePath}" reads browser global "${node.name}".`,
          suggestion:
            "Guard browser-only code behind client execution or move it to the client entry.",
        });
      },
    };
  },
});

const browserGlobals = new Set([
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "navigator",
]);
