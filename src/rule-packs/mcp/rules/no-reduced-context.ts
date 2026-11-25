import { createRule } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";
import { clientLimitsVisitor } from "./client-limits.js";

export const noReducedContext = createRule({
  meta: {
    id: "mcp/clients/no-reduced-context",
    title: "Give clients what the model needs up front",
    description:
      "Report MCP servers whose `initialize` result or tool count leaves a client showing the model less than the server offers.",
    why: "Clients decide what part of a server reaches the model. With tool search, Claude Code loads only tool names and server instructions at session start, so a server without instructions gives Claude only names to decide when to search. VS Code sends at most 128 tools per request, so a server with more makes users deselect tools, or the request fails. A missing-instructions Diagnostic is `info`; a tool count over the limit is `warn`. Doctor checks the `initialize` result and `tools/list` it reads as Runtime Evidence and quotes each client's source.",
    recommendedReplacement:
      "Return `instructions` from `initialize` saying what the tools are for, and keep a server within 128 tools.",
    examples: [
      {
        title: "Send server instructions",
        language: "json",
        invalid: '{\n  "protocolVersion": "2025-11-25",\n  "serverInfo": { "name": "orders" }\n}',
        valid:
          '{\n  "protocolVersion": "2025-11-25",\n  "serverInfo": { "name": "orders" },\n  "instructions": "Tools to search, create, and refund orders. Search before you create."\n}',
      },
    ],
    category: "clients",
    severity: "info",
    confidence: "runtime-backed",
    fixable: false,
    diagnosticCodes: ["MCP0009"],
    docsUrl: "https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search",
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
      ruleId: "mcp/clients/no-reduced-context",
      diagnostic: diagnostics.MCP0009,
      effect: "context",
      outcome: "reaches the model with less context",
    });
  },
});
