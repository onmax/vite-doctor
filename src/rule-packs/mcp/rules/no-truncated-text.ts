import { createRule } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";
import { clientLimitsVisitor } from "./client-limits.js";

export const noTruncatedText = createRule({
  meta: {
    id: "mcp/clients/no-truncated-text",
    title: "Keep MCP tool text within client limits",
    description:
      "Report MCP tool descriptions, schemas, and server instructions in a server's `tools/list` that a client cuts before the model reads them.",
    why: "A client that cuts text keeps the tool, so nothing fails: the model just reads less. Claude Code cuts tool descriptions and server instructions at 4,096 characters. With gpt-4* models, VS Code's Copilot Chat cuts schema descriptions at 1,024 characters. Copilot Studio truncates an input schema whose `type` lists several types. Whatever came after the cut, often the parameter rules or the when-to-call guidance, never reaches the model. Doctor checks the `tools/list` it reads as Runtime Evidence; the Diagnostic names each client, the measured length, and the client's source.",
    recommendedReplacement:
      "Keep descriptions and instructions within the limits, with the critical details first, and give each schema `type` a single type.",
    examples: [
      {
        title: "Use one type per property",
        language: "json",
        invalid:
          '{\n  "name": "search",\n  "inputSchema": {\n    "type": "object",\n    "properties": { "cursor": { "type": ["string", "null"] } }\n  }\n}',
        valid:
          '{\n  "name": "search",\n  "inputSchema": {\n    "type": "object",\n    "properties": { "cursor": { "type": "string" } }\n  }\n}',
      },
    ],
    category: "clients",
    severity: "warn",
    confidence: "runtime-backed",
    fixable: false,
    diagnosticCodes: ["MCP0006"],
    docsUrl: "https://code.claude.com/docs/en/mcp#tool-search-for-mcp-server-authors",
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
      ruleId: "mcp/clients/no-truncated-text",
      diagnostic: diagnostics.MCP0006,
      effect: "truncated",
      outcome: "has text cut",
      brief: "cut",
    });
  },
});
