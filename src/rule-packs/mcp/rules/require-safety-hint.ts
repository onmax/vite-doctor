import { checkMcpToolList } from "@loadsheet/mcp";
import { createRule } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";
import {
  annotationsEvidence,
  collectMcpTools,
  toolLabel,
  type McpToolDefinition,
} from "./shared.js";
import { definedToolFingerprint, reportWireTools, wireTools } from "./wire.js";

const SAFETY_BRIEF = "neither readOnlyHint nor destructiveHint is true";

/** The fix `@loadsheet/mcp` gives a tool on the wire with the same hints, so both paths agree. */
function hintFix(readOnlyHint: unknown, destructiveHint: unknown): string {
  const [found] = checkMcpToolList(
    [{ name: "tool", annotations: { readOnlyHint, destructiveHint } }],
    {
      codes: ["MCP0002"],
    },
  );
  return found!.fix;
}

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
        reportWireTools(ctx, sent, "MCP0002", {
          ruleId: "mcp/tools/require-safety-hint",
          diagnostic: diagnostics.MCP0002,
          range: (tool) =>
            tool.annotations.state === "absent" ? tool.callee : tool.annotations.range,
          source: missingSafetyHint,
        });
        for (const tool of sourceOnly) {
          if (missingSafetyHint(tool) !== true) continue;
          const { annotations } = tool;
          const hints = safetyHints(tool);
          ctx.report(
            diagnostics.MCP0002({
              why: `MCP tool ${toolLabel(tool)} sets neither \`readOnlyHint\` nor \`destructiveHint\` to true. Anthropic's Connectors Directory requires \`readOnlyHint: true\` for read-only tools or \`destructiveHint: true\` for tools that modify or delete data.`,
              fix: hintFix(
                hints[0]?.state === "resolved" ? hints[0].value : undefined,
                hints[1]?.state === "resolved" ? hints[1].value : undefined,
              ),
            }),
            {
              ruleId: "mcp/tools/require-safety-hint",
              severity: ctx.severity,
              category: "tools",
              file: tool.file,
              range: annotations.state === "resolved" ? annotations.range : tool.callee,
              confidence: "heuristic-high",
              fingerprint: tool.name
                ? definedToolFingerprint(
                    ctx,
                    "mcp/tools/require-safety-hint",
                    tool.file,
                    tool.name.value,
                  )
                : undefined,
              brief: SAFETY_BRIEF,
              data: tool.name ? { tool: tool.name.value } : undefined,
              evidence: annotationsEvidence(tool),
            },
          );
        }
      },
    };
  },
});

function safetyHints(tool: McpToolDefinition) {
  const { annotations } = tool;
  return annotations.state === "resolved"
    ? [annotations.values.get("readOnlyHint"), annotations.values.get("destructiveHint")]
    : [];
}

/** Whether no safety hint is true; `undefined` when Doctor can't resolve one. */
function missingSafetyHint(tool: McpToolDefinition): boolean | undefined {
  if (tool.annotations.state === "partial") return undefined;
  const hints = safetyHints(tool);
  if (hints.some((hint) => hint?.state === "resolved" && hint.value === true)) return false;
  return hints.some((hint) => hint?.state === "unknown") ? undefined : true;
}
