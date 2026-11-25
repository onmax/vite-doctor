import { createRule } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";
import { annotationsEvidence, collectMcpTools, toolLabel } from "./shared.js";
import { reportWireTool, wireToolLabel, wireTools } from "./wire.js";

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
    confidence: "heuristic-high",
    fixable: "suggestion",
    diagnosticCodes: ["MCP0002"],
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
        for (const wire of sent) {
          if (!wire.findings.some((finding) => finding.rule === "claude-directory/missing-hint"))
            continue;
          // ChatGPT's confirmation prompt is the same condition seen from a client, so its source
          // backs this Diagnostic instead of becoming a second one.
          const findings = wire.findings.filter(
            (finding) =>
              finding.rule === "claude-directory/missing-hint" ||
              finding.rule === "chatgpt/missing-read-only-hint",
          );
          const chatgpt = findings.some((finding) => finding.client === "chatgpt");
          reportWireTool(
            ctx,
            wire,
            diagnostics.MCP0002({
              why: `MCP tool ${wireToolLabel(wire)} sets neither \`readOnlyHint\` nor \`destructiveHint\` to true in its tools/list entry. Anthropic's Connectors Directory requires \`readOnlyHint: true\` for read-only tools or \`destructiveHint: true\` for tools that modify or delete data.${chatgpt ? " ChatGPT also treats it as a write action that needs the user's confirmation by default, because it has no `readOnlyHint`." : ""}`,
              fix: "Add `readOnlyHint: true` to the annotations if the tool only reads, or `destructiveHint: true` if it changes or deletes data. Only you can tell which one is true.",
            }),
            {
              ruleId: "mcp/tools/require-safety-hint",
              range: (tool) =>
                tool.annotations.state === "absent" ? tool.callee : tool.annotations.range,
              findings,
            },
          );
        }
        for (const tool of sourceOnly) {
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
              data: tool.name ? { tool: tool.name.value } : undefined,
              evidence: annotationsEvidence(tool),
            },
          );
        }
      },
    };
  },
});
