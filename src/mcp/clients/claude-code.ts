import { isSchema } from "../schema.js";
import type { McpClientRule } from "../types.js";
import { declaresDraft2020OrNothing, draft2020Errors } from "../validate.js";
import { assumedNote, docs, hasImage, resultText, serverName, textLength } from "./shared.js";

const DOCS = "https://code.claude.com/docs/en/mcp";
const DESCRIPTION_LIMIT = 4_096;
const DEFERRED_DESCRIPTION_LIMIT = 16_384;
const RESULT_CHARS = 50_000;
const RESULT_CHARS_CEILING = 500_000;
const ERROR_CHARS = 11_000;
const TOKEN_WARNING = 10_000;
const TOKEN_LIMIT = 25_000;
const PROPERTY_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

export const toolNameLength: McpClientRule = {
  client: "claude-code",
  rule: "claude-code/tool-name-length",
  scope: "tool",
  effect: "excluded",
  severity: "error",
  confidence: "high",
  source: docs(
    `${DOCS}#tools-with-names-longer-than-128-characters`,
    "Claude Code leaves an MCP tool out of the tools it sends to Claude when its full name is over 128 characters.",
  ),
  check(tool, context) {
    const server = serverName(context);
    const length = `mcp__${server.name}__${tool.name}`.length;
    if (length <= 128) return;
    return {
      message: `Claude Code leaves \`${tool.name}\` out of the tools it sends to Claude: its full name \`mcp__<server>__${tool.name}\` is ${length} characters${assumedNote(server)}, over 128.`,
      fix: "Shorten the tool name so `mcp__<server>__<tool>` stays within 128 characters.",
      pointer: "/name",
      measured: { value: length, limit: 128, unit: "characters" },
    };
  },
};

export const propertyName: McpClientRule = {
  client: "claude-code",
  rule: "claude-code/property-name",
  scope: "tool",
  effect: "excluded",
  severity: "error",
  confidence: "high",
  source: docs(
    `${DOCS}#tools-with-invalid-input-schemas`,
    "Top-level property names must be 1 to 64 characters long and use only ASCII letters and digits, `_`, `.`, and `-`",
  ),
  check(tool) {
    const properties = tool.inputSchema?.properties;
    if (!isSchema(properties)) return;
    return Object.keys(properties)
      .filter((name) => !PROPERTY_NAME.test(name))
      .map((name) => ({
        message: `Claude Code excludes \`${tool.name}\`: the top-level property name ${JSON.stringify(name)} is not 1 to 64 ASCII letters, digits, \`_\`, \`.\` or \`-\`.`,
        fix: "Rename the property to 1 to 64 characters from `A-Z`, `a-z`, `0-9`, `_`, `.` and `-`.",
        pointer: `/inputSchema/properties/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`,
      }));
  },
};

export const schemaDraft2020: McpClientRule = {
  client: "claude-code",
  rule: "claude-code/schema-draft-2020-12",
  scope: "tool",
  effect: "excluded",
  severity: "error",
  confidence: "high",
  source: docs(
    `${DOCS}#tools-with-invalid-input-schemas`,
    "The schema must be valid against the JSON Schema draft 2020-12 meta-schema. Claude Code applies this check to schemas that declare no `$schema` and schemas that declare draft 2020-12.",
  ),
  check(tool) {
    const schema = tool.inputSchema;
    if (!isSchema(schema) || !declaresDraft2020OrNothing(schema)) return;
    const errors = draft2020Errors(schema);
    if (!errors.length) return;
    return {
      message: `Claude Code excludes \`${tool.name}\`: its input schema is invalid against the JSON Schema draft 2020-12 meta-schema (${errors.slice(0, 3).join("; ")}).`,
      fix: "Make the input schema valid draft 2020-12, for example `items` takes one schema and tuples use `prefixItems`.",
      pointer: "/inputSchema",
    };
  },
};

export const rootCombinator: McpClientRule = {
  client: "claude-code",
  rule: "claude-code/root-combinator",
  scope: "tool",
  effect: "rewritten",
  severity: "warn",
  confidence: "high",
  source: docs(
    `${DOCS}#tool-input-schemas-with-a-root-level-combinator`,
    "Before sending the tool to the API, Claude Code flattens the schema into a single object and prepends a sentence to the tool's description that tells Claude which parameter groups belong together",
  ),
  check(tool) {
    const schema = tool.inputSchema;
    if (!isSchema(schema)) return;
    const keywords = ["anyOf", "oneOf", "allOf"].filter((keyword) => keyword in schema);
    if (!keywords.length) return;
    return {
      message: `Claude Code flattens the root \`${keywords.join("`, `")}\` of \`${tool.name}\` into one object and describes the branches in prose, or skips the tool when it can't.`,
      fix: "Declare one root object schema and keep combinators inside `properties`.",
      pointer: `/inputSchema/${keywords[0]}`,
    };
  },
};

export const descriptionLength: McpClientRule = {
  client: "claude-code",
  rule: "claude-code/description-length",
  scope: "tool",
  effect: "truncated",
  severity: "warn",
  confidence: "high",
  source: docs(
    `${DOCS}#tool-search-for-mcp-server-authors`,
    "Server instructions, and the description of a tool that loads upfront: 4,096 characters",
  ),
  check(tool) {
    const length = tool.description?.length ?? 0;
    if (length <= DESCRIPTION_LIMIT) return;
    const deferred =
      length > DEFERRED_DESCRIPTION_LIMIT
        ? `, and at 16,384 when it loads through tool search`
        : `; through tool search it keeps up to 16,384, but search matches only the first 4,096`;
    return {
      message: `Claude Code cuts the description of \`${tool.name}\` (${length} characters) at 4,096 characters when the tool loads upfront${deferred}.`,
      fix: "Keep the description within 4,096 characters and put the words Claude searches for near the start.",
      pointer: "/description",
      measured: { value: length, limit: DESCRIPTION_LIMIT, unit: "characters" },
    };
  },
};

export const instructionsLength: McpClientRule = {
  client: "claude-code",
  rule: "claude-code/instructions-length",
  scope: "server",
  effect: "truncated",
  severity: "warn",
  confidence: "high",
  source: docs(
    `${DOCS}#tool-search-for-mcp-server-authors`,
    "Server instructions, and the description of a tool that loads upfront: 4,096 characters",
  ),
  check(list) {
    const length = list.initialize?.instructions?.length ?? 0;
    if (length <= DESCRIPTION_LIMIT) return;
    return {
      message: `Claude Code cuts the server instructions (${length} characters) at 4,096 characters, and Claude sees only the text before the cut.`,
      fix: "Keep the instructions within 4,096 characters, with the critical details first.",
      pointer: "/initialize/instructions",
      measured: { value: length, limit: DESCRIPTION_LIMIT, unit: "characters" },
    };
  },
};

export const missingInstructions: McpClientRule = {
  client: "claude-code",
  rule: "claude-code/missing-instructions",
  scope: "server",
  effect: "context",
  severity: "info",
  confidence: "high",
  source: docs(
    `${DOCS}#scale-with-mcp-tool-search`,
    "Only tool names and server instructions load at session start",
  ),
  check(list) {
    if (!list.initialize || list.initialize.instructions?.trim()) return;
    return {
      message:
        "The server sends no instructions, so with tool search Claude Code shows Claude only the tool names until it searches.",
      fix: "Return `instructions` from `initialize` saying what tasks the tools handle and when to search for them.",
      pointer: "/initialize/instructions",
    };
  },
};

export const resultSavedToFile: McpClientRule = {
  client: "claude-code",
  rule: "claude-code/result-saved-to-file",
  scope: "result",
  effect: "context",
  severity: "warn",
  confidence: "high",
  source: docs(
    `${DOCS}#mcp-output-limits-and-warnings`,
    "Claude Code saves a successful result with no image content to a file once it's longer than 50,000 characters, whatever its token count.",
  ),
  check(result, context) {
    if (result.isError || hasImage(result)) return;
    const declared = context.tool?._meta?.["anthropic/maxResultSizeChars"];
    const limit =
      typeof declared === "number" && declared > RESULT_CHARS
        ? Math.min(declared, RESULT_CHARS_CEILING)
        : RESULT_CHARS;
    const length = textLength(result);
    if (length <= limit) return;
    return {
      message: `Claude Code saves this ${length}-character result to a file and gives Claude only the path, since it is over ${limit.toLocaleString("en-US")} characters.`,
      fix:
        limit < RESULT_CHARS_CEILING
          ? 'Return less text, paginate, or set `_meta["anthropic/maxResultSizeChars"]` on the tool (up to 500,000).'
          : "Return less text or paginate.",
      pointer: "/content",
      measured: { value: length, limit, unit: "characters" },
    };
  },
};

export const errorResultTruncated: McpClientRule = {
  client: "claude-code",
  rule: "claude-code/error-result-truncated",
  scope: "result",
  effect: "truncated",
  severity: "warn",
  confidence: "high",
  source: docs(
    `${DOCS}#mcp-output-limits-and-warnings`,
    "Error text longer than about 11,000 characters keeps only its first 5,000 and last 5,000 characters, with a marker between them that says how many characters were removed",
  ),
  check(result) {
    if (!result.isError) return;
    const length = textLength(result);
    if (length <= ERROR_CHARS) return;
    return {
      message: `Claude Code keeps only the first and last 5,000 characters of this ${length}-character error.`,
      fix: "Put the cause and the next step in the first 5,000 characters of the error text.",
      pointer: "/content",
      measured: { value: length, limit: ERROR_CHARS, unit: "characters" },
      // "About 11,000": close to the threshold the cut is likely, not certain.
      confidence: length > ERROR_CHARS * 1.1 ? "high" : "medium",
    };
  },
};

export const resultTokenLimit: McpClientRule = {
  client: "claude-code",
  rule: "claude-code/result-token-limit",
  scope: "result",
  effect: "context",
  severity: "warn",
  confidence: "high",
  source: docs(
    `${DOCS}#mcp-output-limits-and-warnings`,
    "Over the limit: when a successful result with no image content exceeds the token limit, Claude Code saves it to a file and replaces it in the conversation with a message that names the file path",
  ),
  check(result, context) {
    if (!context.countTokens || result.isError || hasImage(result)) return;
    if (typeof context.tool?._meta?.["anthropic/maxResultSizeChars"] === "number") return;
    const tokens = context.countTokens(resultText(result));
    if (tokens <= TOKEN_LIMIT) return;
    return {
      message: `Claude Code saves this ${tokens}-token result to a file, since it is over the default 25,000-token MAX_MCP_OUTPUT_TOKENS.`,
      fix: "Return less text or paginate.",
      pointer: "/content",
      measured: { value: tokens, limit: TOKEN_LIMIT, unit: "tokens" },
    };
  },
};

export const resultTokenWarning: McpClientRule = {
  client: "claude-code",
  rule: "claude-code/result-token-warning",
  scope: "result",
  effect: "context",
  severity: "info",
  confidence: "high",
  source: docs(
    `${DOCS}#mcp-output-limits-and-warnings`,
    "the transcript viewer displays a warning when any MCP tool output exceeds a fixed 10,000 tokens",
  ),
  check(result, context) {
    if (!context.countTokens) return;
    const tokens = context.countTokens(resultText(result));
    if (tokens <= TOKEN_WARNING) return;
    return {
      message: `Claude Code warns in the transcript that this ${tokens}-token result is over 10,000 tokens.`,
      fix: "Return less text or paginate.",
      pointer: "/content",
      measured: { value: tokens, limit: TOKEN_WARNING, unit: "tokens" },
    };
  },
};

export const claudeCodeRules: McpClientRule[] = [
  toolNameLength,
  propertyName,
  schemaDraft2020,
  rootCombinator,
  descriptionLength,
  instructionsLength,
  missingInstructions,
  resultSavedToFile,
  errorResultTruncated,
  resultTokenLimit,
  resultTokenWarning,
];
