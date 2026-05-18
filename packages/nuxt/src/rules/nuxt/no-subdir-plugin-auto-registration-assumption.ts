import { AnyNode, createRule, isExplicitPlugin } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

export const noSubdirPluginAutoRegistrationAssumption = createRule({
  meta: {
    id: "nuxt/plugins/no-subdir-auto-registration-assumption",
    title: "Nested plugins are not auto-registered by default",
    category: "plugins",
    severity: "warn",
    fixable: "suggestion",
    requires: { nuxt: true },
  },
  create(ctx) {
    if (!/^app\/plugins\/[^/]+\/.+\.[cm]?[jt]s$/.test(ctx.file.relativePath)) return;
    if (/^app\/plugins\/[^/]+\/index\.[cm]?[jt]s$/.test(ctx.file.relativePath)) return;
    if (isExplicitPlugin(ctx)) return;
    let reported = false;
    const reportOnce = () => {
      if (reported) return;
      reported = true;
      ctx.report(
        diagnostics.NUXT0041.report({
          why: ctx.project.nuxt?.manifest?.hasManifest
            ? "This nested plugin is not included in Nuxt's configured plugin registration list."
            : "Nuxt auto-registers top-level plugin files and index files, not arbitrary nested plugin files.",
          fix: "Move this plugin to app/plugins/, rename it to an index file, or register it explicitly.",
        }),
        {
          ruleId: "nuxt/plugins/no-subdir-auto-registration-assumption",
          severity: "warn",
          category: "plugins",
          file: ctx.file.path,
        },
      );
    };
    return {
      ScriptNode(node: AnyNode) {
        if (node.type === "Program") reportOnce();
      },
    };
  },
});
