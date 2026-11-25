import type { McpClientRule } from "../types.js";
import { docs, resultText } from "./shared.js";

const RESULT_CHARS = 150_000;

export const resultSize: McpClientRule = {
  client: "claude",
  rule: "claude/result-size",
  scope: "result",
  effect: "truncated",
  severity: "warn",
  // The docs give the limit, not what happens past it.
  confidence: "medium",
  source: docs(
    "https://claude.com/docs/connectors/building#design-within-the-size-and-timeout-limits",
    "| Maximum tool result size | \\~150,000 characters | 25,000 tokens, configurable with `MAX_MCP_OUTPUT_TOKENS` |",
  ),
  check(result) {
    const length = resultText(result).length;
    if (length <= RESULT_CHARS) return;
    return {
      message: `This ${length}-character result is over the ~150,000-character tool result limit of claude.ai and Claude Desktop, so Claude likely doesn't get all of it.`,
      fix: "Return less text or paginate.",
      pointer: "/content",
      measured: { value: length, limit: RESULT_CHARS, unit: "characters" },
    };
  },
};

export const claudeRules: McpClientRule[] = [resultSize];
