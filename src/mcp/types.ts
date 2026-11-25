/** A JSON Schema as an MCP server sends it. */
export type McpJsonSchema = { [keyword: string]: unknown };

/** One entry of an MCP `tools/list` result. */
export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: McpJsonSchema;
  outputSchema?: McpJsonSchema;
  annotations?: { [hint: string]: unknown };
  [field: string]: unknown;
}

/** The fields of an MCP `initialize` result the checks read. */
export interface McpInitializeResult {
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string; [field: string]: unknown };
  instructions?: string;
  [field: string]: unknown;
}

/** What a client sees when it connects: the `initialize` result and every page of `tools/list`. */
export interface McpToolList {
  initialize?: McpInitializeResult;
  tools: McpTool[];
}
