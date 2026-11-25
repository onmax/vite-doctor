import { isSchema } from "../schema.js";
import type { McpClientRule } from "../types.js";
import { draft07Errors } from "../validate.js";
import {
  assumedNote,
  docs,
  inputPointer,
  listPointers,
  schemaNodesVia,
  source,
  structuredContentHidesText,
  undescribedConstraints,
} from "./shared.js";

const VSCODE = "https://github.com/microsoft/vscode/blob/24bc9d5278687dbdd90e8013b93e1daac453ae2b";
const MCP_SERVER = `${VSCODE}/src/vs/workbench/contrib/mcp/common/mcpServer.ts`;
const NORMALIZER = `${VSCODE}/extensions/copilot/src/extension/tools/common/toolSchemaNormalizer.ts`;
const TOOL_LIMIT = 128;
const GPT4_DESCRIPTION_LIMIT = 1_024;
const ID_LIMIT = 64;
const ID_PREFIX = "mcp_";
const MAX_PREFIX = 18;
const INVALID_NAME_CHARACTERS = /[^a-z0-9_-]/gi;
const ROOT_KEYWORDS = ["oneOf", "anyOf", "allOf", "not", "if", "then", "else"];

// forEachSchemaNode in toolSchemaNormalizer.ts; it never enters `$defs`.
const NORMALIZED_STRUCTURE = new Set([
  "properties",
  "items",
  "patternProperties",
  "dependencies",
  "additionalProperties",
  "anyOf",
  "allOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "contains",
]);

// gpt4oUnsupportedSchemaKeywords, limited to keywords that constrain a value; losing `default`
// never makes the server reject a call.
const GPT4_DROPPED_CONSTRAINTS = new Set([
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "multipleOf",
  "minProperties",
  "maxProperties",
  "minContains",
  "maxContains",
  "minItems",
  "maxItems",
  "uniqueItems",
]);

export const schemaDraft07: McpClientRule = {
  client: "vscode",
  rule: "vscode/schema-draft-07",
  scope: "tool",
  effect: "excluded",
  severity: "error",
  confidence: "high",
  source: source(
    `${MCP_SERVER}#L1114-L1160`,
    "this._logger.warn(`${tools.length - validated.length} tools have invalid JSON schemas and will be omitted`);",
  ),
  check(tool) {
    const schema = tool.inputSchema;
    if (!isSchema(schema)) return;
    // VS Code adds an empty `properties` before validating.
    const errors = draft07Errors(schema.properties ? schema : { ...schema, properties: {} });
    if (!errors.length) return;
    return {
      message: `VS Code omits \`${tool.name}\`: its input schema is invalid against the JSON Schema draft-07 meta-schema (${errors.slice(0, 3).join("; ")}).`,
      fix: "Make the input schema valid draft-07 as well as 2020-12: avoid keywords whose shape changed, such as numeric `exclusiveMinimum` alongside draft-04 booleans.",
      pointer: "/inputSchema",
    };
  },
};

export const rootCombinator: McpClientRule = {
  client: "vscode",
  rule: "vscode/root-combinator",
  scope: "tool",
  effect: "stripped",
  severity: "warn",
  confidence: "high",
  source: source(
    `${NORMALIZER}#L130-L138`,
    "// validated this fails both for claude and 4o\n\t\tconst unsupported = ['oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else'];",
  ),
  check(tool) {
    const schema = tool.inputSchema;
    if (!isSchema(schema)) return;
    const keywords = ROOT_KEYWORDS.filter((keyword) => Object.hasOwn(schema, keyword));
    if (!keywords.length) return;
    return {
      message: `VS Code's Copilot Chat deletes the root \`${keywords.join("`, `")}\` from the schema of \`${tool.name}\` before sending it to the model.`,
      fix: "Declare one root object schema and keep combinators inside `properties`.",
      pointer: `/inputSchema/${keywords[0]}`,
      affectedPointers: keywords.map((keyword) => `/inputSchema/${keyword}`),
    };
  },
};

export const missingDescription: McpClientRule = {
  client: "vscode",
  rule: "vscode/missing-description",
  scope: "tool",
  effect: "rewritten",
  severity: "warn",
  confidence: "high",
  source: source(
    `${MCP_SERVER}#L1094-L1098`,
    "this._logger.warn(`Tool ${tool.name} does not have a description. Tools must be accurately described to be called`);\n\t\t\ttool.description = '<empty>';",
  ),
  check(tool) {
    if (tool.description) return;
    return {
      message: `VS Code gives \`${tool.name}\` the description \`<empty>\` because it has none, so the model has only the name to go on.`,
      fix: "Describe what the tool does and when to call it.",
      pointer: "/description",
    };
  },
};

export const toolCount: McpClientRule = {
  client: "vscode",
  rule: "vscode/tool-count",
  scope: "server",
  effect: "context",
  severity: "warn",
  confidence: "high",
  source: docs(
    "https://code.visualstudio.com/docs/agents/run/tools",
    "If a Local request reports Cannot have more than 128 tools per request, select Configure Tools and deselect unneeded tools or MCP servers.",
  ),
  check(list) {
    const count = list.tools.length;
    if (count <= TOOL_LIMIT) return;
    return {
      message: `VS Code sends at most 128 tools per request and this server alone has ${count}, so users must deselect tools or the request fails unless Copilot Chat groups them for on-demand discovery.`,
      fix: "Expose fewer tools, for example by merging related tools or splitting the server by task.",
      measured: { value: count, limit: TOOL_LIMIT, unit: "tools" },
    };
  },
};

export const arrayWithoutItems: McpClientRule = {
  client: "vscode",
  rule: "vscode/array-without-items",
  scope: "tool",
  effect: "excluded",
  severity: "warn",
  // The source throws; that the request then fails is inferred.
  confidence: "medium",
  source: source(
    `${NORMALIZER}#L100-L106`,
    "if (n && 'type' in n && n.type === 'array' && !(n as ArrayJsonSchema).items) {\n\t\t\t\tthrow new Error('tool parameters array type must have items');",
  ),
  check(tool) {
    const pointers: string[] = [];
    for (const node of schemaNodesVia(tool, NORMALIZED_STRUCTURE))
      if (node.schema.type === "array" && !node.schema.items)
        pointers.push(inputPointer(node.pointer));
    if (!pointers.length) return;
    return {
      message: `VS Code's Copilot Chat throws "tool parameters array type must have items" for \`${tool.name}\` (${listPointers(pointers)}), so requests that include it likely fail.`,
      fix: 'Give every `type: "array"` schema an `items` schema.',
      pointer: pointers[0],
      affectedPointers: pointers,
    };
  },
};

export const gpt4DescriptionLength: McpClientRule = {
  client: "vscode",
  rule: "vscode/gpt-4-description-length",
  scope: "tool",
  effect: "truncated",
  severity: "warn",
  confidence: "high",
  source: source(
    `${NORMALIZER}#L108-L117`,
    "if (n && 'description' in n && n.description && n.description.length > gpt4oMaxStringLength) {\n\t\t\t\tn.description = n.description.substring(0, gpt4oMaxStringLength);",
  ),
  check(tool) {
    const hits = [];
    for (const node of schemaNodesVia(tool, NORMALIZED_STRUCTURE)) {
      const description = node.schema.description;
      if (typeof description !== "string" || description.length <= GPT4_DESCRIPTION_LIMIT) continue;
      const pointer = inputPointer(`${node.pointer}/description`);
      hits.push({
        message: `With gpt-4* models, VS Code's Copilot Chat cuts the description at \`${pointer}\` of \`${tool.name}\` (${description.length} characters) to 1,024 characters.`,
        fix: "Keep schema descriptions within 1,024 characters; move longer guidance to the tool description.",
        pointer,
        measured: {
          value: description.length,
          limit: GPT4_DESCRIPTION_LIMIT,
          unit: "characters" as const,
        },
      });
    }
    return hits;
  },
};

export const gpt4DroppedConstraints: McpClientRule = {
  client: "vscode",
  rule: "vscode/gpt-4-dropped-constraints",
  scope: "tool",
  effect: "stripped",
  severity: "info",
  confidence: "high",
  source: source(
    `${NORMALIZER}#L119-L128`,
    "if (gpt4oUnsupportedSchemaKeywords.has(key)) {\n\t\t\t\t\tdelete (n as any)[key];\n\t\t\t\t\tonFix(`object has unsupported schema keyword '${key}'`);",
  ),
  check(tool) {
    const dropped = undescribedConstraints(tool, GPT4_DROPPED_CONSTRAINTS, NORMALIZED_STRUCTURE);
    if (!dropped.length) return;
    const keywords = [...new Set(dropped.map((item) => item.keyword))];
    const pointers = dropped.map((item) => item.pointer);
    return {
      message: `With gpt-4* models, VS Code's Copilot Chat deletes \`${keywords.join("`, `")}\` from the schema of \`${tool.name}\`: ${listPointers(pointers)}.`,
      fix: "If the model needs a limit to call the tool right, state it in the property description, such as `Between 1 and 100.`, and keep validating it on the server.",
      pointer: pointers[0],
      affectedPointers: pointers,
    };
  },
};

export const nameCharacters: McpClientRule = {
  client: "vscode",
  rule: "vscode/name-characters",
  scope: "tool",
  effect: "rewritten",
  severity: "info",
  confidence: "high",
  source: source(
    `${MCP_SERVER}#L1100-L1103`,
    "this._logger.warn(`Tool ${JSON.stringify(tool.name)} is invalid. Tools names may only contain [a-z0-9_-]`);\n\t\t\ttool.name = tool.name.replace(toolInvalidCharRe, '_');",
  ),
  check(tool) {
    if (!tool.name.match(INVALID_NAME_CHARACTERS)) return;
    const rewritten = tool.name.replace(INVALID_NAME_CHARACTERS, "_");
    return {
      message: `VS Code renames \`${tool.name}\` to \`${rewritten}\` and logs a warning, replacing characters outside \`a-z\`, \`0-9\`, \`_\` and \`-\`.`,
      fix: "Use only letters, digits, `_` and `-` in the tool name.",
      pointer: "/name",
    };
  },
};

export const nameLength: McpClientRule = {
  client: "vscode",
  rule: "vscode/name-length",
  scope: "tool",
  effect: "rewritten",
  severity: "info",
  confidence: "high",
  source: source(
    `${MCP_SERVER}#L1347`,
    "this.id = (idPrefix + _definition.name).replaceAll('.', '_').slice(0, McpToolName.MaxLength);",
  ),
  check(tool, context) {
    // VS Code prefixes tools with the server's announced title or name before the mcp.json key.
    const info = context.initialize?.serverInfo;
    const announced = info?.title || info?.name || context.serverName;
    const server = { name: announced || "s", assumed: !announced };
    const slug = server.name
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "_")
      .slice(0, MAX_PREFIX - ID_PREFIX.length - 1);
    const name = tool.name.replace(INVALID_NAME_CHARACTERS, "_");
    const id = `${ID_PREFIX}${slug}_${name}`.replaceAll(".", "_");
    if (id.length <= ID_LIMIT) return;
    return {
      message: `VS Code cuts the tool id \`${id}\` to its first 64 characters, \`${id.slice(0, ID_LIMIT)}\`${assumedNote(server)}.`,
      fix: "Shorten the tool name so `mcp_<server>_<tool>` stays within 64 characters.",
      pointer: "/name",
      measured: { value: id.length, limit: ID_LIMIT, unit: "characters" },
    };
  },
};

export const structuredContentOnly: McpClientRule = {
  client: "vscode",
  rule: "vscode/structured-content-replaces-text",
  scope: "result",
  effect: "stripped",
  severity: "warn",
  confidence: "high",
  source: source(
    `${VSCODE}/src/vs/workbench/contrib/mcp/common/mcpLanguageModelToolContribution.ts#L331-L337`,
    "// structured content 'represents the result of the tool call', so take\n\t\t\t\t// that in place of any textual description when present.",
  ),
  check(result) {
    if (!result.structuredContent || !structuredContentHidesText(result)) return;
    return {
      message:
        "VS Code gives the model `structuredContent` in place of the text in `content`, which says something else, so that text never reaches it.",
      fix: "Put everything the model needs in `structuredContent`, or make the text content the same JSON.",
      pointer: "/structuredContent",
    };
  },
};

export const vscodeRules: McpClientRule[] = [
  schemaDraft07,
  rootCombinator,
  missingDescription,
  toolCount,
  arrayWithoutItems,
  gpt4DescriptionLength,
  gpt4DroppedConstraints,
  nameCharacters,
  nameLength,
  structuredContentOnly,
];
