import { nameProblems } from "@loadsheet/mcp";
import { createRule } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";
import { collectMcpTools, definedToolFingerprint, type McpToolDefinition } from "./shared.js";

export const validName = createRule({
  meta: {
    id: "mcp/tools/valid-name",
    title: "Keep MCP tool names short and plain",
    description:
      "Report MCP tool names longer than 64 characters or with characters outside A-Z, a-z, 0-9, `_`, `-`, and `.`.",
    why: "MCP limits tool names to ASCII letters, digits, `_`, `-`, and `.`, and up to 128 characters. Anthropic's Connectors Directory is stricter and rejects names longer than 64 characters. Clients that turn tools into model function calls can't reliably use a name with spaces or other characters.",
    recommendedReplacement:
      "Rename the tool to at most 64 characters, using only letters, digits, `_`, `-`, and `.`.",
    examples: [
      {
        title: "Use a plain tool name",
        language: "ts",
        invalid: "defineTool({ name: 'list order suggestions', handler })",
        valid: "defineTool({ name: 'list_order_suggestions', handler })",
      },
    ],
    category: "tools",
    severity: "warn",
    confidence: "heuristic-medium",
    fixable: false,
    diagnosticCodes: ["MCP0003"],
    docsUrl: "https://modelcontextprotocol.io/specification/2025-11-25/server/tools#tool-names",
    execution: "workspace",
    cacheScope: "none",
    requires: { crossFile: true },
    requiresContext: ["cross-file"],
    consumesEvidence: ["ast"],
    cost: "medium",
  },
  create(ctx) {
    return {
      async onWorkspaceEnd() {
        for (const tool of await collectMcpTools(ctx)) {
          const name = tool.name;
          if (!name) continue;
          const advice = sourceAdvice(tool);
          if (!advice) continue;
          ctx.report(diagnostics.MCP0003({ why: advice.why, fix: advice.fix }), {
            ruleId: "mcp/tools/valid-name",
            severity: ctx.severity,
            category: "tools",
            file: tool.file,
            range: name.range,
            confidence: name.source === "file" ? "heuristic-medium" : "heuristic-high",
            fingerprint: definedToolFingerprint(ctx, "mcp/tools/valid-name", tool.file, name.value),
            brief: advice.brief,
            data: { tool: name.value },
            evidence: [
              {
                kind: "ast",
                file: tool.file,
                range: name.range,
                summary:
                  name.source === "file"
                    ? `The ${tool.library} toolkit names this tool after its file.`
                    : `The tool is registered as ${JSON.stringify(name.value)}.`,
              },
            ],
          });
        }
      },
    };
  },
});

function sourceAdvice(tool: McpToolDefinition) {
  const name = tool.name;
  if (!name) return undefined;
  const problems = nameProblems(name.value);
  if (!problems.length) return false;
  const problem = problems.join(" and ");
  const origin = name.source === "file" ? " It comes from the file name." : "";
  return {
    why: `MCP tool name ${JSON.stringify(name.value)} ${problem}.${origin} Anthropic's Connectors Directory rejects names over 64 characters, and MCP allows only letters, digits, \`_\`, \`-\`, and \`.\`.`,
    fix:
      name.source === "file"
        ? tool.library === "@vite-hub/mcp"
          ? "Rename or move the tool file so its discovered name is at most 64 letters, digits, `_`, `-`, or `.`."
          : "Rename the file, or set `name` on the definition, to at most 64 letters, digits, `_`, `-`, or `.`."
        : "Rename the tool to at most 64 letters, digits, `_`, `-`, or `.`.",
    brief: `name ${problem}`,
  };
}
