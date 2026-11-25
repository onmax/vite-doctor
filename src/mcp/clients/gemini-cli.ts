import type { McpClientRule } from "../types.js";
import { assumedNote, serverName, source } from "./shared.js";

const MCP_TOOL =
  "https://github.com/google-gemini/gemini-cli/blob/08e9a20f749aefcbda38622ac757899c3d6216e0/packages/core/src/tools/mcp-tool.ts";
const SAFE_LIMIT = 63;
const INVALID_CHARACTERS = /[^a-zA-Z0-9_\-.:]/g;

/** `generateValidName` in mcp-tool.ts applied to `<server>_<tool>`, before its middle cut. */
function qualifiedName(server: string, tool: string): string {
  const qualified = `${server}_${tool}`;
  const name = (qualified.startsWith("mcp_") ? qualified : `mcp_${qualified}`).replace(
    INVALID_CHARACTERS,
    "_",
  );
  return /^[^a-zA-Z_]/.test(name) ? `_${name}` : name;
}

export const nameCharacters: McpClientRule = {
  client: "gemini-cli",
  rule: "gemini-cli/name-characters",
  scope: "tool",
  effect: "rewritten",
  severity: "info",
  confidence: "high",
  source: source(
    `${MCP_TOOL}#L725-L734`,
    "// Replace invalid characters with underscores to conform to Gemini API:\n  // ^[a-zA-Z_][a-zA-Z0-9_\\-.:]{0,63}$\n  validToolname = validToolname.replace(/[^a-zA-Z0-9_\\-.:]/g, '_');",
  ),
  check(tool) {
    if (!tool.name.match(INVALID_CHARACTERS)) return;
    return {
      message: `Gemini CLI shows \`${tool.name}\` to the model as \`${tool.name.replace(INVALID_CHARACTERS, "_")}\`, replacing characters outside \`A-Z\`, \`a-z\`, \`0-9\`, \`_\`, \`-\`, \`.\` and \`:\`.`,
      fix: "Use only letters, digits, `_`, `-`, `.` and `:` in the tool name if the model should see it unchanged.",
      pointer: "/name",
    };
  },
};

export const nameLength: McpClientRule = {
  client: "gemini-cli",
  rule: "gemini-cli/name-length",
  scope: "tool",
  effect: "rewritten",
  severity: "info",
  confidence: "high",
  source: source(
    `${MCP_TOOL}#L738-L747`,
    "// If longer than the API limit, replace middle with '...'\n  // Note: We use 63 instead of 64 to be safe, as some environments have off-by-one behaviors.\n  const safeLimit = MAX_FUNCTION_NAME_LENGTH - 1;",
  ),
  check(tool, context) {
    const server = serverName(context);
    const name = qualifiedName(server.name, tool.name);
    if (name.length <= SAFE_LIMIT) return;
    const cut = `${name.slice(0, 30)}...${name.slice(-30)}`;
    return {
      message: `Gemini CLI replaces the middle of \`mcp_<server>_${tool.name}\` (${name.length} characters${assumedNote(server)}) with \`...\`, keeping the first and last 30 characters (\`${cut}\`), and warns that the tool may require user approval.`,
      fix: "Shorten the tool name so `mcp_<server>_<tool>` stays within 63 characters.",
      pointer: "/name",
      measured: { value: name.length, limit: SAFE_LIMIT, unit: "characters" },
    };
  },
};

export const geminiCliRules: McpClientRule[] = [nameCharacters, nameLength];
