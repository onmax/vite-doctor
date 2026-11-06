import { createRule } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";
import { collectMcpTools } from "./shared.js";

const NAME_CHARACTERS = /^[A-Za-z0-9_.-]+$/;
const MAX_NAME_LENGTH = 64;

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
          const problems: string[] = [];
          if (name.value.length === 0) problems.push("is empty");
          if (name.value.length > MAX_NAME_LENGTH)
            problems.push(`is ${name.value.length} characters long`);
          if (name.value.length > 0 && !NAME_CHARACTERS.test(name.value))
            problems.push("uses characters other than letters, digits, `_`, `-`, and `.`");
          if (!problems.length) continue;
          const origin = name.source === "file" ? " It comes from the file name." : "";
          ctx.report(
            diagnostics.MCP0003({
              why: `MCP tool name ${JSON.stringify(name.value)} ${problems.join(" and ")}.${origin} Anthropic's Connectors Directory rejects names over 64 characters, and MCP allows only letters, digits, \`_\`, \`-\`, and \`.\`.`,
              fix:
                name.source === "file"
                  ? "Rename the file, or set `name` on the definition, to at most 64 letters, digits, `_`, `-`, or `.`."
                  : "Rename the tool to at most 64 letters, digits, `_`, `-`, or `.`.",
            }),
            {
              ruleId: "mcp/tools/valid-name",
              severity: ctx.severity,
              category: "tools",
              file: tool.file,
              range: name.range,
              confidence: name.source === "file" ? "heuristic-medium" : "heuristic-high",
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
