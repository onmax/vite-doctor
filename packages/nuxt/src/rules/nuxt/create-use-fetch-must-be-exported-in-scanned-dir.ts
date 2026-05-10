import { AnyNode, createRule, report } from "./shared.js";

export const createUseFetchMustBeExportedInScannedDir = createRule({
  meta: {
    id: "nuxt/fetch/create-usefetch-must-be-exported-in-scanned-dir",
    title: "Export data factories from scanned composable directories",
    category: "fetching",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        const name = ctx.helpers.getCalleeName(node);
        if (name !== "createUseFetch" && name !== "createUseAsyncData") return;
        const exported = /export\s+(const|function)\s+use[A-Z]\w+/.test(
          ctx.file.text.slice(Math.max(0, node.start - 120), node.start),
        );
        const scanned =
          ctx.file.relativePath.startsWith("app/composables/") &&
          !/^app\/composables\/[^/]+\/.+/.test(ctx.file.relativePath);
        if (exported && scanned) return;
        report(
          ctx,
          node,
          "nuxt/fetch/create-usefetch-must-be-exported-in-scanned-dir",
          "error",
          "fetching",
          "Nuxt data factories need to be exported from scanned composable files for compiler key injection.",
          "Export the factory from a top-level app/composables file or configure imports.dirs.",
        );
      },
    };
  },
});
