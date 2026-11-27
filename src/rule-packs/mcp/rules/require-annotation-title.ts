import { createRule } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";
import {
  annotationsEvidence,
  collectMcpTools,
  toolLabel,
  type McpToolDefinition,
} from "./shared.js";
import { definedToolFingerprint, reportWireTool, wireTools } from "./wire.js";

export const requireAnnotationTitle = createRule({
  meta: {
    id: "mcp/tools/require-annotation-title",
    title: "Give every MCP tool an annotations.title",
    description: "Report MCP tools whose annotations have no human-readable title.",
    why: "Clients show a tool by its title, and MCP has carried it in `annotations.title` since the 2025-03-26 revision. The top-level `title` only arrived in 2025-06-18, so older clients never see it, and some newer client surfaces still ignore it: Claude Code's transcript shows the bare tool name. Anthropic's Connectors Directory review asks every tool for a `title` and hint annotations, and its portal has flagged tools that set only the top-level `title`. Both MCP toolkits fill the top-level `title` from the file name and pass `annotations` through as written, so a file-discovered tool ships without one unless you add it.",
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
    confidence: "heuristic-high",
    fixable: "suggestion",
    diagnosticCodes: ["MCP0001"],
    docsUrl: "https://claude.com/docs/connectors/building/review-criteria#provide-tool-annotations",
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
        for (const wire of sent)
          reportWireTool(ctx, wire, "MCP0001", {
            ruleId: "mcp/tools/require-annotation-title",
            diagnostic: diagnostics.MCP0001,
            range: annotationsRange,
            source: missingTitle,
          });
        for (const tool of sourceOnly) {
          if (missingTitle(tool) !== true) continue;
          const { annotations } = tool;
          const label = toolLabel(tool);
          const topLevel = tool.title
            ? tool.title.source === "file"
              ? ` Its top-level title "${tool.title.value}" comes from the file name, and the toolkit doesn't copy it into the annotations.`
              : ` It has a top-level title "${tool.title.value}", which some client surfaces ignore: Claude Code's transcript, for example, shows the bare name${tool.name ? ` \`${tool.name.value}\`` : ""}, and clients on the 2025-03-26 revision know only \`annotations.title\`.`
            : " Clients show only the bare tool name.";
          const suggested = tool.title?.value ?? "<Human-readable name>";
          ctx.report(
            diagnostics.MCP0001({
              why: `MCP tool ${label} has no non-empty string in \`annotations.title\`.${topLevel} Anthropic's Connectors Directory review asks every tool for a \`title\` and hint annotations, and its portal flags tools missing them${tool.title ? "; it has flagged tools that set only the top-level `title`" : ""}.`,
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
              range: annotationsRange(tool),
              confidence: "heuristic-high",
              fingerprint: tool.name
                ? definedToolFingerprint(
                    ctx,
                    "mcp/tools/require-annotation-title",
                    tool.file,
                    tool.name.value,
                  )
                : undefined,
              brief: `no annotations.title; add title: ${JSON.stringify(suggested)}`,
              data: tool.name ? { tool: tool.name.value } : undefined,
              evidence: annotationsEvidence(tool),
            },
          );
        }
      },
    };
  },
});

/** Whether the definition has no `annotations.title`; `undefined` when Doctor can't resolve it. */
function missingTitle(tool: McpToolDefinition): boolean | undefined {
  const { annotations } = tool;
  if (annotations.state === "partial") return undefined;
  const title = annotations.state === "resolved" ? annotations.values.get("title") : undefined;
  if (title?.state === "unknown") return undefined;
  return !(
    title?.state === "resolved" &&
    typeof title.value === "string" &&
    title.value.trim().length > 0
  );
}

function annotationsRange(tool: McpToolDefinition) {
  return tool.annotations.state === "absent" ? tool.callee : tool.annotations.range;
}
