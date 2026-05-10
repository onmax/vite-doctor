import { AnyNode, createRule } from "./shared.js";

export const noLegacyProcessClientServer = createRule({
  meta: {
    id: "nuxt/context/no-legacy-process-client-server",
    title: "Use import.meta client/server flags",
    category: "context",
    severity: "warn",
    fixable: "safe",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        const name = ctx.helpers.getNodeName(node);
        if (name !== "process.client" && name !== "process.server") return;
        const replacement = name === "process.client" ? "import.meta.client" : "import.meta.server";
        ctx.report({
          ruleId: "nuxt/context/no-legacy-process-client-server",
          severity: "warn",
          category: "context",
          file: ctx.file.path,
          range: ctx.range(node),
          message: `${name} is a legacy Nuxt runtime flag in Nuxt 4 code.`,
          suggestion: `Use ${replacement}.`,
          fix: {
            kind: "safe",
            edits: [{ range: { start: node.start, end: node.end }, text: replacement }],
          },
        });
      },
    };
  },
});
