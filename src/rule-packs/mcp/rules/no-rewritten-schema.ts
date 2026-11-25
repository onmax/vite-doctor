import { createRule } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";
import { clientLimitsVisitor } from "./client-limits.js";

export const noRewrittenSchema = createRule({
  meta: {
    id: "mcp/clients/no-rewritten-schema",
    title: "Send MCP tools clients pass on unchanged",
    description:
      "Report MCP tools in a server's `tools/list` whose name, description, or input schema a client rewrites before the model sees it.",
    why: "Some clients reshape a tool instead of rejecting it. Codex, Gemini CLI, Cursor, and VS Code rename tools whose names use other characters or run past their length limits, so the model calls a name your docs and logs don't use. Copilot Studio reads `enum` inputs as plain strings, and VS Code gives a tool without a description the description `<empty>`. Claude Code flattens a root `anyOf`, `oneOf`, or `allOf` into one object described in prose. Most of these are `info`: the tool still works. A Diagnostic is `warn` when the model is left with less to go on, such as an empty description or a flattened root combinator. Doctor checks the `tools/list` it reads as Runtime Evidence and quotes each client's source.",
    recommendedReplacement:
      "Use short tool names of letters, digits, and `_`; describe every tool; list `enum` values in the description; and declare one root object schema.",
    examples: [
      {
        title: "Declare one root object schema",
        language: "json",
        invalid:
          '{\n  "name": "lookup",\n  "description": "Look up a user.",\n  "inputSchema": {\n    "anyOf": [\n      { "type": "object", "properties": { "id": { "type": "string" } } },\n      { "type": "object", "properties": { "email": { "type": "string" } } }\n    ]\n  }\n}',
        valid:
          '{\n  "name": "lookup",\n  "description": "Look up a user by id or email.",\n  "inputSchema": {\n    "type": "object",\n    "properties": { "id": { "type": "string" }, "email": { "type": "string" } }\n  }\n}',
      },
    ],
    category: "clients",
    severity: "info",
    confidence: "runtime-backed",
    fixable: false,
    diagnosticCodes: ["MCP0007"],
    docsUrl: "https://code.claude.com/docs/en/mcp#tool-input-schemas-with-a-root-level-combinator",
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
      ruleId: "mcp/clients/no-rewritten-schema",
      diagnostic: diagnostics.MCP0007,
      effect: "rewritten",
      outcome: "is rewritten",
    });
  },
});
