import { CODEX_SCHEMA_MAX_BYTES, reduceCodexInputSchema } from "../codex-schema.js";
import type { McpClientRule } from "../types.js";
import {
  assumedNote,
  listPointers,
  serverName,
  source,
  structuredContentHidesText,
  undescribedConstraints,
} from "./shared.js";

const CODEX =
  "https://github.com/openai/codex/blob/ebd0765aafa255d63ebf690ebdffe0164dc14a0c/codex-rs";
const NAME_LIMIT = 128;
const DELIMITER = "__";

// Keywords outside the JsonSchema struct (types.rs) that constrain a value; Codex drops them all.
const DROPPED_CONSTRAINTS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "default",
]);
const KEPT_STRUCTURE = new Set([
  "properties",
  "items",
  "additionalProperties",
  "anyOf",
  "oneOf",
  "allOf",
  "$defs",
  "definitions",
]);

const PASS_EFFECTS = {
  "strip-descriptions": "strips every description from the schema",
  "drop-definitions": "drops `$defs` and `definitions`, replacing references with `{}`",
  "collapse-deep-objects": "replaces objects nested deeper than three levels with `{}`",
  "prune-compositions": "replaces every `anyOf`, `oneOf` and `allOf` with `{}`",
} as const;

export const schemaSize: McpClientRule = {
  client: "codex",
  rule: "codex/schema-size",
  scope: "tool",
  effect: "stripped",
  severity: "warn",
  confidence: "high",
  source: source(
    `${CODEX}/tools/src/json_schema/compaction.rs#L16-L46`,
    "// Measure compact normalized JSON in UTF-8 bytes.\npub(crate) const DEFAULT_COMPACT_TOOL_SCHEMA_BYTES: usize = 5_000;",
  ),
  check(tool) {
    const reduction = reduceCodexInputSchema(tool.inputSchema);
    if (!reduction?.passes.length) return;
    const effects = reduction.passes.map((pass) => PASS_EFFECTS[pass]).join(", then ");
    return {
      message: `Codex ${effects} for \`${tool.name}\`: its input schema is ${reduction.bytes} bytes of compact JSON after Codex's reduction, over the 5,000-byte default.`,
      fix: "Shrink the input schema below 5,000 bytes: shorter property descriptions, fewer nested objects, details in the tool description.",
      pointer: "/inputSchema",
      measured: { value: reduction.bytes, limit: CODEX_SCHEMA_MAX_BYTES, unit: "bytes" },
    };
  },
};

export const droppedConstraints: McpClientRule = {
  client: "codex",
  rule: "codex/dropped-constraints",
  scope: "tool",
  effect: "stripped",
  severity: "info",
  confidence: "high",
  source: source(
    `${CODEX}/tools/src/json_schema/types.rs#L35-L78`,
    "/// Generic JSON-Schema subset needed for our tool definitions.",
  ),
  check(tool) {
    const descriptionsSurvive = !reduceCodexInputSchema(tool.inputSchema)?.passes.includes(
      "strip-descriptions",
    );
    const dropped = undescribedConstraints(
      tool,
      DROPPED_CONSTRAINTS,
      KEPT_STRUCTURE,
      descriptionsSurvive,
    );
    if (!dropped.length) return;
    const keywords = [...new Set(dropped.map((item) => item.keyword))];
    const pointers = dropped.map((item) => item.pointer);
    return {
      message: `Codex drops \`${keywords.join("`, `")}\` from the schema of \`${tool.name}\`: ${listPointers(pointers)}.`,
      fix: "If the model needs a limit to call the tool right, state it in the property description, such as `Between 1 and 100.`, and keep validating it on the server.",
      pointer: pointers[0],
      affectedPointers: pointers,
    };
  },
};

export const nameCharacters: McpClientRule = {
  client: "codex",
  rule: "codex/name-characters",
  scope: "tool",
  effect: "rewritten",
  severity: "info",
  confidence: "high",
  source: source(
    `${CODEX}/codex-mcp/src/mcp/mod.rs#L655-L672`,
    "/// MCP server/tool names are user-controlled, so sanitize the fully-qualified\n/// name we expose to the model by replacing any disallowed character with `_`.",
  ),
  check(tool) {
    if (/^[A-Za-z0-9_]+$/.test(tool.name)) return;
    const rewritten = tool.name.replace(/[^A-Za-z0-9_]/g, "_");
    return {
      message: `Codex shows \`${tool.name}\` to the model as \`${rewritten}\`, replacing characters outside \`A-Z\`, \`a-z\`, \`0-9\` and \`_\`.`,
      fix: "Use only letters, digits and `_` in the tool name if the model should see it unchanged.",
      pointer: "/name",
    };
  },
};

export const nameLength: McpClientRule = {
  client: "codex",
  rule: "codex/name-length",
  scope: "tool",
  effect: "rewritten",
  severity: "info",
  confidence: "high",
  source: source(
    `${CODEX}/codex-mcp/src/tools.rs#L267-L268`,
    "const MAX_TOOL_NAME_LENGTH: usize = 128;\nconst CALLABLE_NAME_HASH_LEN: usize = 12;",
  ),
  check(tool, context) {
    const server = serverName(context);
    // Without the default `mcp__` namespace prefix, the shortest name Codex can build.
    const length = server.name.length + DELIMITER.length + tool.name.length;
    if (length <= NAME_LIMIT) return;
    return {
      message: `Codex cuts the name of \`${tool.name}\` and appends a 12-character hash: \`<server>__${tool.name}\` is ${length} bytes${assumedNote(server)}, over 128.`,
      fix: "Shorten the tool name.",
      pointer: "/name",
      measured: { value: length, limit: NAME_LIMIT, unit: "characters" },
    };
  },
};

export const structuredContentOnly: McpClientRule = {
  client: "codex",
  rule: "codex/structured-content-replaces-text",
  scope: "result",
  effect: "stripped",
  severity: "warn",
  confidence: "high",
  source: source(
    `${CODEX}/protocol/src/models.rs#L2500-L2508`,
    "if let Some(structured_content) = &self.structured_content\n            && !structured_content.is_null()\n        {\n            match serde_json::to_string(structured_content) {\n                Ok(serialized_structured_content) => {\n                    return FunctionCallOutputPayload {\n                        body: FunctionCallOutputBody::Text(serialized_structured_content),",
  ),
  check(result) {
    if (result.structuredContent === null || result.structuredContent === undefined) return;
    if (!structuredContentHidesText(result)) return;
    return {
      message:
        "Codex sends the model only `structuredContent` as JSON, so the text in `content`, which says something else, never reaches it.",
      fix: "Put everything the model needs in `structuredContent`, or make the text content the same JSON.",
      pointer: "/structuredContent",
    };
  },
};

export const codexRules: McpClientRule[] = [
  schemaSize,
  droppedConstraints,
  nameCharacters,
  nameLength,
  structuredContentOnly,
];
