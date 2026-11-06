import { createRule } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";
import { annotationsEvidence, collectMcpTools, toolLabel } from "./shared.js";

export const requireSafetyHint = createRule({
  meta: {
    id: "mcp/tools/require-safety-hint",
    title: "Declare whether an MCP tool reads or changes data",
    description:
      "Report MCP tools whose annotations set neither `readOnlyHint` nor `destructiveHint` to true.",
    why: "Clients decide from these hints whether a tool may run without asking. MCP's defaults are `readOnlyHint: false` and `destructiveHint: true`, so a tool that declares neither is treated as one that may destroy data. Claude prompts before every call to such a tool, and Anthropic's Connectors Directory flags it at submission.",
    recommendedReplacement:
      "Set `readOnlyHint: true` on a tool that only reads, or `destructiveHint: true` on one that changes or deletes data.",
    examples: [
      {
        title: "Mark a read-only tool",
        language: "ts",
        invalid:
          "export default defineMcpTool({\n  name: 'list_drops',\n  title: 'List drops',\n  annotations: { title: 'List drops' },\n  handler: () => listDrops(),\n})",
        valid:
          "export default defineMcpTool({\n  name: 'list_drops',\n  title: 'List drops',\n  annotations: { title: 'List drops', readOnlyHint: true },\n  handler: () => listDrops(),\n})",
      },
    ],
    category: "tools",
    severity: "warn",
    fixable: "suggestion",
    diagnosticCodes: ["MCP0002"],
    docsUrl: "https://claude.com/docs/connectors/building/review-criteria#provide-tool-annotations",
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
          const { annotations } = tool;
          if (annotations.state === "partial") continue;
          const hints =
            annotations.state === "resolved"
              ? [annotations.values.get("readOnlyHint"), annotations.values.get("destructiveHint")]
              : [];
          if (
            hints.some(
              (hint) =>
                hint?.state === "unknown" || (hint?.state === "resolved" && hint.value === true),
            )
          )
            continue;
          ctx.report(
            diagnostics.MCP0002({
              why: `MCP tool ${toolLabel(tool)} sets neither \`readOnlyHint\` nor \`destructiveHint\` to true. Anthropic's Connectors Directory requires \`readOnlyHint: true\` for read-only tools or \`destructiveHint: true\` for tools that modify or delete data.`,
              fix: "Add `readOnlyHint: true` to the annotations if the tool only reads, or `destructiveHint: true` if it changes or deletes data. Only you can tell which one is true.",
            }),
            {
              ruleId: "mcp/tools/require-safety-hint",
              severity: ctx.severity,
              category: "tools",
              file: tool.file,
              range: annotations.state === "resolved" ? annotations.range : tool.callee,
              confidence: "heuristic-high",
              evidence: annotationsEvidence(tool),
            },
          );
        }
      },
    };
  },
});
