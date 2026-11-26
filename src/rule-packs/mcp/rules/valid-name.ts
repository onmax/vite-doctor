import { createRule } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";
import { collectMcpTools } from "./shared.js";
import { reportWireTool, wireToolLabel, wireTools } from "./wire.js";

const NAME_CHARACTERS = /^[A-Za-z0-9_.-]+$/;
const MAX_NAME_LENGTH = 64;

/** What makes a tool name break MCP's character set or the Connectors Directory's length limit. */
export function nameProblems(name: string): string[] {
  const problems: string[] = [];
  if (name.length === 0) problems.push("is empty");
  if (name.length > MAX_NAME_LENGTH) problems.push(`is ${name.length} characters long`);
  if (name.length > 0 && !NAME_CHARACTERS.test(name))
    problems.push("uses characters other than letters, digits, `_`, `-`, and `.`");
  return problems;
}

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
    consumesEvidence: ["ast", "runtime"],
    cost: "medium",
  },
  create(ctx) {
    return {
      async onWorkspaceEnd() {
        const { tools: sent, sourceOnly } = wireTools(ctx, await collectMcpTools(ctx));
        for (const wire of sent) {
          const problems = nameProblems(wire.tool.name);
          if (!problems.length) continue;
          reportWireTool(
            ctx,
            wire,
            diagnostics.MCP0003({
              why: `MCP tool ${wireToolLabel(wire)} has a name that ${problems.join(" and ")} in its tools/list entry. Anthropic's Connectors Directory rejects names over 64 characters, and MCP allows only letters, digits, \`_\`, \`-\`, and \`.\`.`,
              fix: "Rename the tool to at most 64 letters, digits, `_`, `-`, or `.`.",
            }),
            {
              ruleId: "mcp/tools/valid-name",
              range: (tool) => tool.name?.range ?? tool.callee,
              findings: wire.findings.filter((finding) => finding.pointer === "/name"),
              brief: `name ${problems.join(" and ")}`,
            },
          );
        }
        for (const tool of sourceOnly) {
          const name = tool.name;
          if (!name) continue;
          const problems = nameProblems(name.value);
          if (!problems.length) continue;
          const origin = name.source === "file" ? " It comes from the file name." : "";
          ctx.report(
            diagnostics.MCP0003({
              why: `MCP tool name ${JSON.stringify(name.value)} ${problems.join(" and ")}.${origin} Anthropic's Connectors Directory rejects names over 64 characters, and MCP allows only letters, digits, \`_\`, \`-\`, and \`.\`.`,
              fix:
                name.source === "file"
                  ? tool.library === "@vite-hub/mcp"
                    ? "Rename or move the tool file so its discovered name is at most 64 letters, digits, `_`, `-`, or `.`."
                    : "Rename the file, or set `name` on the definition, to at most 64 letters, digits, `_`, `-`, or `.`."
                  : "Rename the tool to at most 64 letters, digits, `_`, `-`, or `.`.",
            }),
            {
              ruleId: "mcp/tools/valid-name",
              severity: ctx.severity,
              category: "tools",
              file: tool.file,
              range: name.range,
              confidence: name.source === "file" ? "heuristic-medium" : "heuristic-high",
              brief: `name ${problems.join(" and ")}`,
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
            },
          );
        }
      },
    };
  },
});
