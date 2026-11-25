import { createRule } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";
import { clientLimitsVisitor } from "./client-limits.js";

export const noExcludedTool = createRule({
  meta: {
    id: "mcp/clients/no-excluded-tool",
    title: "Send MCP tools every client accepts",
    description:
      "Report MCP tools in a server's `tools/list` that a client leaves out, or that make its requests fail, because of the tool's name or input schema.",
    why: "Clients validate tools before they reach the model, each against its own limits. Claude Code excludes a tool whose full name is over 128 characters, whose top-level property names aren't plain, or whose schema isn't valid draft 2020-12. VS Code omits a tool whose schema isn't valid draft-07. Copilot Studio drops a tool with `$ref` and fails on a numeric `exclusiveMinimum`. The server still answers `tools/list` without an error, so the tool works in your own tests and is missing for users of that client. Doctor checks the `tools/list` it reads as Runtime Evidence; the Diagnostic names each client and quotes its source. A Diagnostic is `error` when a client leaves the tool out, and `warn` when the failure is inferred from the client's source.",
    recommendedReplacement:
      "Keep tool names short, inline referenced schemas, use plain top-level property names, and keep the input schema valid against both draft-07 and draft 2020-12.",
    examples: [
      {
        title: "Inline the referenced schema",
        language: "json",
        invalid:
          '{\n  "name": "search",\n  "inputSchema": {\n    "type": "object",\n    "properties": { "filter": { "$ref": "#/$defs/filter" } },\n    "$defs": { "filter": { "type": "string" } }\n  }\n}',
        valid:
          '{\n  "name": "search",\n  "inputSchema": {\n    "type": "object",\n    "properties": { "filter": { "type": "string" } }\n  }\n}',
      },
    ],
    category: "clients",
    severity: "error",
    confidence: "runtime-backed",
    fixable: false,
    diagnosticCodes: ["MCP0005"],
    docsUrl: "https://code.claude.com/docs/en/mcp#tools-with-invalid-input-schemas",
    execution: "workspace",
    activationScope: "workspace",
    cacheScope: "none",
    requires: { crossFile: true },
    requiresContext: ["cross-file"],
    consumesEvidence: ["runtime", "ast"],
    determinism: "runtime-dependent",
    cost: "small",
  },
  create(ctx) {
    return clientLimitsVisitor(ctx, {
      ruleId: "mcp/clients/no-excluded-tool",
      diagnostic: diagnostics.MCP0005,
      effect: "excluded",
      outcome: "is left out, or makes requests fail,",
    });
  },
});
