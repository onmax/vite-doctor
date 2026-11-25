import type { McpClientRule } from "../types.js";
import { docs } from "./shared.js";

const REVIEW = "https://claude.com/docs/connectors/building/review-criteria";
const ANNOTATIONS_QUOTE =
  "Every tool must include a `title` and the applicable hint: `readOnlyHint: true` for read-only tools, and `destructiveHint: true` for tools that modify or delete data.";

export const toolNameLength: McpClientRule = {
  client: "claude-directory",
  rule: "claude-directory/tool-name-length",
  scope: "tool",
  effect: "review",
  severity: "warn",
  confidence: "high",
  source: docs(`${REVIEW}#keep-tool-names-short`, "Tool names must be 64 characters or fewer."),
  check(tool) {
    if (tool.name.length <= 64) return;
    return {
      message: `Directory review requires tool names of 64 characters or fewer; \`${tool.name}\` has ${tool.name.length}.`,
      fix: "Shorten the tool name to 64 characters or fewer.",
      pointer: "/name",
      measured: { value: tool.name.length, limit: 64, unit: "characters" },
    };
  },
};

export const missingTitle: McpClientRule = {
  client: "claude-directory",
  rule: "claude-directory/missing-title",
  scope: "tool",
  effect: "review",
  severity: "warn",
  confidence: "high",
  source: docs(`${REVIEW}#provide-tool-annotations`, ANNOTATIONS_QUOTE),
  // The Directory's portal flags a tool whose annotations have no title even when the top-level
  // `title` is set, so only `annotations.title` counts.
  check(tool) {
    const title = tool.annotations?.title;
    if (typeof title === "string" && title.trim()) return;
    return {
      message: `Directory review requires a title on every tool and reads it from \`annotations.title\`; \`${tool.name}\` has none there.`,
      fix: `Set \`annotations.title\` to a human-readable name${typeof tool.title === "string" && tool.title.trim() ? `, such as the top-level title ${JSON.stringify(tool.title)}` : ""}.`,
      pointer: "/annotations/title",
    };
  },
};

/**
 * The fix for a tool with neither safety hint true, when its declared hints narrow it down.
 * A write tool that declares `readOnlyHint: false` must never be told to set it to true.
 */
export function declaredHintFix(hints: {
  readOnlyHint?: unknown;
  destructiveHint?: unknown;
}): string | undefined {
  if (hints.readOnlyHint !== false) return;
  if (hints.destructiveHint === false)
    return "The tool declares both `readOnlyHint: false` and `destructiveHint: false`, but the Connectors Directory needs one of them true. Set whichever one is true for this tool.";
  return "Add `destructiveHint: true` to the annotations. The tool declares `readOnlyHint: false`, and the Connectors Directory asks for `destructiveHint: true` on tools that modify or delete data.";
}

export const missingHint: McpClientRule = {
  client: "claude-directory",
  rule: "claude-directory/missing-hint",
  scope: "tool",
  effect: "review",
  severity: "warn",
  confidence: "high",
  source: docs(`${REVIEW}#provide-tool-annotations`, ANNOTATIONS_QUOTE),
  check(tool) {
    const annotations = tool.annotations ?? {};
    if (annotations.readOnlyHint === true || annotations.destructiveHint === true) return;
    return {
      message: `Directory review requires \`readOnlyHint: true\` or \`destructiveHint: true\` on every tool; \`${tool.name}\` has neither.`,
      fix:
        declaredHintFix(annotations) ??
        "Set `annotations.readOnlyHint: true` on read-only tools and `annotations.destructiveHint: true` on tools that modify or delete data.",
      pointer: "/annotations",
    };
  },
};

export const claudeDirectoryRules: McpClientRule[] = [toolNameLength, missingTitle, missingHint];
