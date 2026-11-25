import { walkSchema } from "../schema.js";
import type { McpClientRule, McpTool } from "../types.js";
import { docs, inputPointer, listPointers } from "./shared.js";

const DOCS =
  "https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-troubleshooting#known-issues-and-workarounds";

function pointersWhere(
  tool: McpTool,
  keyword: string,
  test: (value: unknown) => boolean,
): string[] {
  const pointers: string[] = [];
  for (const node of walkSchema(tool.inputSchema))
    if (Object.hasOwn(node.schema, keyword) && test(node.schema[keyword]))
      pointers.push(inputPointer(`${node.pointer}/${keyword}`));
  return pointers;
}

export const numericExclusiveMinimum: McpClientRule = {
  client: "copilot-studio",
  rule: "copilot-studio/numeric-exclusive-minimum",
  scope: "tool",
  effect: "excluded",
  severity: "error",
  confidence: "high",
  source: docs(
    DOCS,
    "A `System.FormatException` error occurs when the `exclusiveMinimum` property is set to an integer (instead of a Boolean) in the MCP tool definition input schema.",
  ),
  check(tool) {
    const pointers = pointersWhere(tool, "exclusiveMinimum", (value) => Number.isInteger(value));
    if (!pointers.length) return;
    return {
      message: `Copilot Studio fails with \`System.FormatException\` on \`${tool.name}\` because \`exclusiveMinimum\` is an integer: ${listPointers(pointers)}.`,
      fix: "Use `minimum` with the next allowed value, or state the bound in the description.",
      pointer: pointers[0],
      affectedPointers: pointers,
    };
  },
};

export const reference: McpClientRule = {
  client: "copilot-studio",
  rule: "copilot-studio/reference",
  scope: "tool",
  effect: "excluded",
  severity: "error",
  confidence: "high",
  source: docs(
    DOCS,
    "Tools with reference type inputs in the schema are filtered from the list of available tools for MCP server. Reference type inputs and outputs aren't supported.",
  ),
  check(tool) {
    const pointers = pointersWhere(tool, "$ref", (value) => typeof value === "string");
    if (!pointers.length) return;
    return {
      message: `Copilot Studio leaves \`${tool.name}\` out of the server's tools because its input schema uses \`$ref\`: ${listPointers(pointers)}.`,
      fix: "Inline the referenced schemas instead of using `$ref`.",
      pointer: pointers[0],
      affectedPointers: pointers,
    };
  },
};

export const typeArray: McpClientRule = {
  client: "copilot-studio",
  rule: "copilot-studio/type-array",
  scope: "tool",
  effect: "truncated",
  severity: "warn",
  confidence: "high",
  source: docs(
    DOCS,
    "The MCP tool definition input schema definition is truncated when a type in a tool definition is an array of multiple types instead of a single type.",
  ),
  check(tool) {
    const pointers = pointersWhere(
      tool,
      "type",
      (value) => Array.isArray(value) && value.length > 1,
    );
    if (!pointers.length) return;
    return {
      message: `Copilot Studio truncates the input schema of \`${tool.name}\` because a \`type\` lists several types: ${listPointers(pointers)}.`,
      fix: 'Use a single type in each `type` field, for example by making the property optional instead of `["string", "null"]`.',
      pointer: pointers[0],
      affectedPointers: pointers,
    };
  },
};

export const enumAsString: McpClientRule = {
  client: "copilot-studio",
  rule: "copilot-studio/enum-as-string",
  scope: "tool",
  effect: "rewritten",
  severity: "info",
  confidence: "high",
  source: docs(
    DOCS,
    "Tools with enum type inputs in the schema are interpreted as string instead of enum.",
  ),
  check(tool) {
    const pointers = pointersWhere(tool, "enum", Array.isArray);
    if (!pointers.length) return;
    return {
      message: `Copilot Studio reads the \`enum\` inputs of \`${tool.name}\` as strings instead of enums: ${listPointers(pointers)}.`,
      fix: "If the agent needs the allowed values, list them in the property description, and keep validating them on the server.",
      pointer: pointers[0],
      affectedPointers: pointers,
    };
  },
};

export const copilotStudioRules: McpClientRule[] = [
  numericExclusiveMinimum,
  reference,
  typeArray,
  enumAsString,
];
