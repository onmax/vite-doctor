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
  _meta?: { [key: string]: unknown };
  [field: string]: unknown;
}

/** The fields of an MCP `initialize` result the checks read. */
export interface McpInitializeResult {
  protocolVersion?: string;
  serverInfo?: { name?: string; title?: string; version?: string; [field: string]: unknown };
  instructions?: string;
  [field: string]: unknown;
}

/** What a client sees when it connects: the `initialize` result and every page of `tools/list`. */
export interface McpToolList {
  initialize?: McpInitializeResult;
  tools: McpTool[];
}

/** One item of a `tools/call` result's `content`. */
export interface McpContentItem {
  type: string;
  text?: string;
  [field: string]: unknown;
}

/** An MCP `tools/call` result. */
export interface McpToolResult {
  content?: McpContentItem[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: { [key: string]: unknown };
  [field: string]: unknown;
}

export type McpClient =
  | "claude-code"
  | "claude"
  | "claude-directory"
  | "chatgpt"
  | "codex"
  | "cursor"
  | "vscode"
  | "gemini-cli"
  | "copilot-studio";

export interface McpSource {
  /** An https permalink or docs anchor. */
  url: string;
  /** The day the source was read, as an ISO date. */
  checked: string;
  /** Verbatim from the source. */
  quote: string;
  kind: "docs" | "source" | "forum";
}

/**
 * What the client does to the tool: leaves it out, cuts it, renames or reshapes it, drops part of
 * it, holds it for review, or changes what reaches the model's context.
 */
export type McpEffect = "excluded" | "truncated" | "rewritten" | "stripped" | "review" | "context";

export interface McpMeasurement {
  value: number;
  limit: number;
  unit: "characters" | "bytes" | "tools" | "tokens";
}

export interface McpFinding {
  client: McpClient;
  /** Stable id, such as `claude-code/tool-name-length`. */
  rule: string;
  effect: McpEffect;
  /** `error`: the client leaves the tool out or the request fails. `warn`: content is lost. `info`: the client rewrites something. */
  severity: "error" | "warn" | "info";
  /** `medium` when the consequence is inferred or the source is a forum answer. */
  confidence: "high" | "medium";
  /** Absent for server-level findings, such as instructions or tool count. */
  tool?: string;
  /** JSON Pointer inside the tool or result, such as `/inputSchema/properties/limit`. */
  pointer?: string;
  /** What the client does, in one sentence. */
  message: string;
  fix: string;
  source: McpSource;
  measured?: McpMeasurement;
}

/** What a rule's `check` returns for each problem it finds; the rule supplies the rest of the finding. */
export interface McpRuleHit {
  message: string;
  fix: string;
  pointer?: string;
  measured?: McpMeasurement;
  /** Overrides the rule's confidence for this hit. */
  confidence?: McpFinding["confidence"];
}

export type McpRuleHits = McpRuleHit | McpRuleHit[] | undefined;

export interface McpListContext {
  /** The name the user gives the server in the client's config, when known. */
  serverName?: string;
  initialize?: McpInitializeResult;
}

export interface McpResultContext {
  /** The called tool's `tools/list` entry, for limits a tool declares, such as `_meta["anthropic/maxResultSizeChars"]`. */
  tool?: McpTool;
  countTokens?: (text: string) => number;
}

interface McpRuleBase {
  client: McpClient;
  rule: string;
  effect: McpEffect;
  severity: McpFinding["severity"];
  confidence: McpFinding["confidence"];
  source: McpSource;
}

/** Checks one tool of a `tools/list` result. */
export interface McpToolRule extends McpRuleBase {
  scope: "tool";
  check(tool: McpTool, context: McpListContext): McpRuleHits;
}

/** Checks the whole server: its `initialize` result and every tool together. */
export interface McpServerRule extends McpRuleBase {
  scope: "server";
  check(list: McpToolList, context: McpListContext): McpRuleHits;
}

/** Checks one `tools/call` result. */
export interface McpResultRule extends McpRuleBase {
  scope: "result";
  check(result: McpToolResult, context: McpResultContext): McpRuleHits;
}

export type McpClientRule = McpToolRule | McpServerRule | McpResultRule;
