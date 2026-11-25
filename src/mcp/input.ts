import { isSchema } from "./schema.js";
import type { McpInitializeResult, McpTool, McpToolList, McpToolResult } from "./types.js";

/**
 * Accepts a bare tools array, `{ tools }`, `{ initialize, tools }`, or a raw JSON-RPC
 * `tools/list` response, so callers can pass whatever their MCP client or test captured.
 */
export function normalizeToolList(input: unknown): McpToolList {
  if (Array.isArray(input)) return { tools: validateTools(input) };
  if (isSchema(input)) {
    rejectJsonRpcError(input, "tools/list");
    if (Array.isArray(input.tools)) {
      const initialize = isSchema(input.initialize)
        ? (input.initialize as McpInitializeResult)
        : undefined;
      return { ...(initialize ? { initialize } : {}), tools: validateTools(input.tools) };
    }
    if ("jsonrpc" in input && isSchema(input.result) && Array.isArray(input.result.tools))
      return { tools: validateTools(input.result.tools) };
  }
  throw new TypeError(
    "Expected a tools array, `{ tools }`, `{ initialize, tools }`, or a JSON-RPC tools/list response.",
  );
}

/** Accepts a `tools/call` result or the raw JSON-RPC response that carries it. */
export function normalizeToolResult(input: unknown): McpToolResult {
  if (isSchema(input)) {
    rejectJsonRpcError(input, "tools/call");
    const isEnvelope =
      "jsonrpc" in input && ("id" in input || "result" in input || "error" in input);
    const result = isEnvelope ? input.result : input;
    if (isSchema(result) && (result.content === undefined || Array.isArray(result.content)))
      return result as McpToolResult;
  }
  throw new TypeError("Expected a tools/call result or a JSON-RPC tools/call response.");
}

// An error response has no result to check; reading it as an empty result would pass every check.
function rejectJsonRpcError(input: Record<string, unknown>, method: string): void {
  if (!("jsonrpc" in input) || !isSchema(input.error)) return;
  const { code, message } = input.error;
  throw new TypeError(
    `Expected a JSON-RPC ${method} result, got an error response${typeof code === "number" ? ` ${code}` : ""}${typeof message === "string" ? `: ${message}` : ""}.`,
  );
}

export function isMcpTool(tool: unknown): tool is McpTool {
  return isSchema(tool) && typeof tool.name === "string";
}

export function validateTools(tools: unknown[]): McpTool[] {
  tools.forEach((tool, index) => {
    if (!isMcpTool(tool))
      throw new TypeError(`tools[${index}] is not an MCP tool with a string \`name\`.`);
  });
  return tools as McpTool[];
}
