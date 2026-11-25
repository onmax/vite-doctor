import type { McpClientRule } from "../types.js";
import { assumedNote, forum, serverName } from "./shared.js";

const NAME_LIMIT = 60;

export const nameLength: McpClientRule = {
  client: "cursor",
  rule: "cursor/name-length",
  scope: "tool",
  effect: "rewritten",
  severity: "info",
  confidence: "medium",
  source: forum(
    "https://forum.cursor.com/t/posthog-mcp-tool-names-too-long/155408/6",
    "The combined server + tool name is exactly 60 characters, and our check fires at “exceeds 60”",
  ),
  check(tool, context) {
    const server = serverName(context);
    const length = server.name.length + tool.name.length;
    if (length <= NAME_LIMIT) return;
    return {
      message: `Cursor warns about \`${tool.name}\` and cuts its name, adding a hash suffix: server name plus tool name is ${length} characters${assumedNote(server)}, over 60.`,
      fix: "Shorten the tool name so server name plus tool name stays within 60 characters.",
      pointer: "/name",
      measured: { value: length, limit: NAME_LIMIT, unit: "characters" },
    };
  },
};

export const structuredContentWithoutContent: McpClientRule = {
  client: "cursor",
  rule: "cursor/structured-content-without-content",
  scope: "result",
  effect: "stripped",
  severity: "warn",
  confidence: "medium",
  source: forum(
    "https://forum.cursor.com/t/mcp-tool-results-containing-only-structuredcontent-are-silently-dropped/167346/6",
    "When a tool result has an empty content array and the payload only in structuredContent, Cursor can show the JSON in the tool card but still deliver an empty result to the model.",
  ),
  check(result) {
    if (result.structuredContent === undefined || result.structuredContent === null) return;
    if (result.content?.length) return;
    return {
      message:
        "Cursor can deliver this result to the model as empty: it has `structuredContent` but an empty `content` array.",
      fix: "Also return the JSON as a text item in `content`, as the MCP spec recommends.",
      pointer: "/content",
    };
  },
};

export const cursorRules: McpClientRule[] = [nameLength, structuredContentWithoutContent];
