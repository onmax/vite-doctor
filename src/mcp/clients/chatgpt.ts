import type { McpClientRule } from "../types.js";
import { docs } from "./shared.js";

export const missingReadOnlyHint: McpClientRule = {
  client: "chatgpt",
  rule: "chatgpt/missing-read-only-hint",
  scope: "tool",
  effect: "review",
  severity: "warn",
  confidence: "high",
  source: docs(
    "https://developers.openai.com/api/docs/guides/developer-mode",
    "Read-only detection: We respect the `readOnlyHint` tool annotation (see MCP tool annotations). Tools without this hint are treated as write actions.",
  ),
  check(tool) {
    if (typeof tool.annotations?.readOnlyHint === "boolean") return;
    return {
      message: `ChatGPT treats \`${tool.name}\` as a write action and asks the user to confirm each call, because it has no \`readOnlyHint\`.`,
      fix: "Set `annotations.readOnlyHint` to `true` on tools that only read, and to `false` on the rest.",
      pointer: "/annotations/readOnlyHint",
    };
  },
};

export const chatgptRules: McpClientRule[] = [missingReadOnlyHint];
