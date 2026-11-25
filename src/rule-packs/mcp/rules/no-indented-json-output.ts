import { createRule } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";
import { collectMcpTools, toolLabel } from "./shared.js";

export const noIndentedJsonOutput = createRule({
  meta: {
    id: "mcp/tools/no-indented-json-output",
    title: "Return compact JSON from MCP tools",
    description:
      "Report MCP tools that return `JSON.stringify(value, replacer, indent)` with an indent as their text.",
    why: "The model reads a tool's text result as tokens in its context window. Indentation adds a newline and spaces before every key and item, which carries no data: in the Quiver Portal MCP it was about a third of each answer's characters. Claude Code flags a result over 10,000 tokens, and replaces one over 25,000 tokens or 50,000 characters with the path of a file that holds it, so padding pushes a large answer past those limits sooner.",
    recommendedReplacement:
      "Remove only the third argument of `JSON.stringify(value, replacer, indent)`; keep the replacer.",
    examples: [
      {
        title: "Return compact JSON",
        language: "ts",
        invalid:
          "export default defineMcpTool({\n  handler: async () => ({\n    content: [{ type: 'text', text: JSON.stringify(await listDrops(), ['id'], 2) }],\n  }),\n})",
        valid:
          "export default defineMcpTool({\n  handler: async () => ({\n    content: [{ type: 'text', text: JSON.stringify(await listDrops(), ['id']) }],\n  }),\n})",
      },
    ],
    category: "tools",
    severity: "warn",
    confidence: "heuristic-high",
    fixable: "suggestion",
    diagnosticCodes: ["MCP0004"],
    docsUrl: "https://code.claude.com/docs/en/mcp#mcp-output-limits-and-warnings",
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
          for (const output of tool.indentedJson) {
            const helper = output.helper;
            ctx.report(
              diagnostics.MCP0004({
                why: helper
                  ? `MCP tool ${toolLabel(tool)} returns indented JSON from a helper in ${helper.displayPath}. The indentation reaches the model as tokens that carry no data.`
                  : `MCP tool ${toolLabel(tool)} returns indented JSON as its text. The indentation reaches the model as tokens that carry no data.`,
                fix: `Remove only the third argument of \`JSON.stringify()\`${helper ? ` in ${helper.displayPath}` : ""}; keep the replacer.`,
              }),
              {
                ruleId: "mcp/tools/no-indented-json-output",
                severity: ctx.severity,
                category: "tools",
                file: tool.file,
                range: output.range,
                confidence: "heuristic-high",
                data: tool.name ? { tool: tool.name.value } : undefined,
                evidence: [
                  helper
                    ? {
                        kind: "ast",
                        file: helper.file,
                        range: helper.range,
                        summary:
                          "The helper the tool returns passes an indent to `JSON.stringify()` and returns its string.",
                      }
                    : {
                        kind: "ast",
                        file: tool.file,
                        range: output.range,
                        summary:
                          "`JSON.stringify()` gets an indent, and the tool returns its string.",
                      },
                ],
              },
            );
          }
        }
      },
    };
  },
});
