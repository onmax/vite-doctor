import { rulesFor, toFindings } from "./check.js";
import { normalizeToolResult } from "./input.js";
import type { McpClient, McpFinding, McpResultContext, McpTool } from "./types.js";

export interface CheckMcpToolResultOptions {
  /** Clients to check against. Defaults to every client. */
  clients?: readonly McpClient[];
  /** Counts tokens the way the client does. Token limits are skipped without it, never estimated. */
  countTokens?: (text: string) => number;
  /** The called tool's `tools/list` entry, for limits it declares in `_meta`. */
  tool?: McpTool;
}

/**
 * Checks one `tools/call` result against what each client does with large or structured
 * results. Accepts the result or the JSON-RPC response that carries it.
 */
export function checkMcpToolResult(
  input: unknown,
  options: CheckMcpToolResultOptions = {},
): McpFinding[] {
  const result = normalizeToolResult(input);
  const context: McpResultContext = { tool: options.tool, countTokens: options.countTokens };
  const findings: McpFinding[] = [];
  for (const rule of rulesFor(options.clients))
    if (rule.scope === "result")
      findings.push(...toFindings(rule, rule.check(result, context), options.tool?.name));
  return findings;
}
