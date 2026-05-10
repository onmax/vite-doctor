import { AnyNode, NUXT_AUTO_IMPORTS, createRule, report } from "./shared.js";

export const noVueOrNitroContextInShared = createRule({
  meta: {
    id: "nuxt/shared/no-vue-or-nitro-context-in-shared",
    title: "Keep shared code runtime-neutral",
    category: "architecture",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!ctx.file.relativePath.startsWith("shared/")) return;
    return {
      ImportDeclaration(node: AnyNode) {
        const source = String(node.source?.value ?? "");
        if (
          !["vue", "nuxt/app", "#app", "h3", "nitropack"].includes(source) &&
          !source.startsWith("#imports")
        )
          return;
        report(
          ctx,
          node,
          "nuxt/shared/no-vue-or-nitro-context-in-shared",
          "error",
          "architecture",
          "shared/ code should be usable by both the Vue app and Nitro server without app/runtime context.",
          "Move Vue composables to app/composables/, Nitro utilities to server/utils/, or keep shared/ pure.",
        );
      },
      ScriptNode(node: AnyNode) {
        const name = ctx.helpers.getCalleeName(node);
        if (!name || !NUXT_AUTO_IMPORTS.has(name)) return;
        report(
          ctx,
          node,
          "nuxt/shared/no-vue-or-nitro-context-in-shared",
          "error",
          "architecture",
          "shared/ code should not call Nuxt app composables or Nitro context helpers.",
          "Move context-aware logic into app/ or server/ and keep shared/ utilities pure.",
        );
      },
    };
  },
});
