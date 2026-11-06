import { createRule } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";
import { annotationsEvidence, collectMcpTools, toolLabel } from "./shared.js";

export const requireAnnotationTitle = createRule({
  meta: {
    id: "mcp/tools/require-annotation-title",
    title: "Give every MCP tool an annotations.title",
    description: "Report MCP tools whose annotations have no human-readable title.",
    why: "Clients show a tool by its title, and MCP has carried it in `annotations.title` since the 2025-03-26 revision. The top-level `title` only arrived in 2025-06-18, so older clients never see it. Anthropic's Connectors Directory requires a title on every tool, and its portal flags tools whose annotations have none, even when a top-level `title` is set. Both MCP toolkits fill the top-level `title` from the file name and pass `annotations` through as written, so a file-discovered tool ships without one unless you add it.",
    recommendedReplacement:
      "Set `annotations.title` to the same human-readable name as the top-level `title`.",
    examples: [
      {
        title: "Name the tool in its annotations",
        language: "ts",
        invalid:
          "export default defineMcpTool({\n  name: 'get_kpis',\n  title: 'Get KPIs',\n  annotations: { readOnlyHint: true },\n  handler: () => kpis(),\n})",
        valid:
          "export default defineMcpTool({\n  name: 'get_kpis',\n  title: 'Get KPIs',\n  annotations: { title: 'Get KPIs', readOnlyHint: true },\n  handler: () => kpis(),\n})",
      },
    ],
    category: "tools",
    severity: "warn",
    fixable: "suggestion",
    diagnosticCodes: ["MCP0001"],
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
          if (annotations.state === "resolved" && annotations.keys.has("title")) continue;
          const label = toolLabel(tool);
          const topLevel = tool.title
            ? tool.title.source === "file"
              ? ` Its top-level title "${tool.title.value}" comes from the file name, and the toolkit doesn't copy it into the annotations.`
              : ` It has a top-level title "${tool.title.value}", which clients that read only \`annotations.title\` never show.`
            : "";
          const suggested = tool.title?.value ?? "<Human-readable name>";
          ctx.report(
            diagnostics.MCP0001({
              why: `MCP tool ${label} has no \`annotations.title\`.${topLevel} Anthropic's Connectors Directory flags tools without one, and clients on the 2025-03-26 revision show only the bare name.`,
              fix:
                annotations.state === "absent"
                  ? `Add \`annotations: { title: ${JSON.stringify(suggested)}, readOnlyHint: true }\` (or \`destructiveHint: true\` for a tool that changes data).`
                  : `Add \`title: ${JSON.stringify(suggested)}\` to the tool's annotations.`,
            }),
            {
              ruleId: "mcp/tools/require-annotation-title",
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
