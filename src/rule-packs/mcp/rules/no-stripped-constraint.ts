import { createRule } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";
import { clientLimitsVisitor } from "./client-limits.js";

export const noStrippedConstraint = createRule({
  meta: {
    id: "mcp/clients/no-stripped-constraint",
    title: "State MCP schema constraints clients drop",
    description:
      "Report MCP tools in a server's `tools/list` whose input schema loses constraints or parts in a client before the model sees it.",
    why: "Codex drops keywords such as `minimum`, `maxLength`, and `pattern` from input schemas, and so does VS Code's Copilot Chat with gpt-4* models. The model can then send values your server rejects. Doctor skips a constraint whose value appears in the tool's or the property's description, a `null`, `false`, or empty default, and a `minLength`, `minItems`, or `minProperties` of 1. Codex also shrinks a schema over 5,000 bytes, and VS Code deletes a root combinator. Dropped constraints are `info`; a Diagnostic is `warn` when a client removes structure, such as a shrunk schema or a deleted root combinator. Doctor checks the `tools/list` it reads as Runtime Evidence and quotes each client's source.",
    recommendedReplacement:
      "State each limit or default in the property description, such as `Between 1 and 100.` or `Defaults to 20.`, keep validating it on the server, and keep input schemas small with one root object.",
    examples: [
      {
        title: "State the limit in the description",
        language: "json",
        invalid:
          '{\n  "name": "list_orders",\n  "inputSchema": {\n    "type": "object",\n    "properties": { "limit": { "type": "integer", "maximum": 100 } }\n  }\n}',
        valid:
          '{\n  "name": "list_orders",\n  "inputSchema": {\n    "type": "object",\n    "properties": {\n      "limit": { "type": "integer", "maximum": 100, "description": "At most 100." }\n    }\n  }\n}',
      },
    ],
    category: "clients",
    severity: "info",
    confidence: "runtime-backed",
    fixable: false,
    diagnosticCodes: ["MCP0008"],
    docsUrl:
      "https://github.com/microsoft/vscode/blob/24bc9d5278687dbdd90e8013b93e1daac453ae2b/extensions/copilot/src/extension/tools/common/toolSchemaNormalizer.ts#L119-L128",
    execution: "workspace",
    cacheScope: "none",
    requires: { crossFile: true },
    requiresContext: ["cross-file"],
    consumesEvidence: ["runtime", "ast"],
    determinism: "runtime-dependent",
    cost: "small",
  },
  create(ctx) {
    return clientLimitsVisitor(ctx, {
      ruleId: "mcp/clients/no-stripped-constraint",
      diagnostic: diagnostics.MCP0008,
      effect: "stripped",
      outcome: "loses part of its input schema",
    });
  },
});
