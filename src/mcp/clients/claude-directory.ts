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
  check(tool) {
    const title = tool.title ?? tool.annotations?.title;
    if (typeof title === "string" && title.trim()) return;
    return {
      message: `Directory review requires a \`title\` on every tool; \`${tool.name}\` has none.`,
      fix: "Add a human-readable `title` to the tool.",
      pointer: "/title",
    };
  },
};

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
      fix: "Set `annotations.readOnlyHint: true` on read-only tools and `annotations.destructiveHint: true` on tools that modify or delete data.",
      pointer: "/annotations",
    };
  },
};

export const claudeDirectoryRules: McpClientRule[] = [toolNameLength, missingTitle, missingHint];
