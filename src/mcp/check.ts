import { mcpClientRules } from "./clients/index.js";
import { normalizeToolList } from "./input.js";
import type { McpClient, McpClientRule, McpFinding, McpListContext, McpRuleHits } from "./types.js";

export interface CheckMcpToolListOptions {
  /** Clients to check against. Defaults to every client. */
  clients?: readonly McpClient[];
  /**
   * The name the user gives the server in the client's config, which clients prefix to tool
   * names. Not `serverInfo.name`. Without it, name-length checks assume a one-character name.
   */
  serverName?: string;
}

/**
 * Checks a server's `tools/list` result against each client's documented or source-confirmed
 * limits. Accepts a tools array, `{ tools }`, `{ initialize, tools }`, or a JSON-RPC response.
 */
export function checkMcpToolList(
  input: unknown,
  options: CheckMcpToolListOptions = {},
): McpFinding[] {
  const list = normalizeToolList(input);
  const context: McpListContext = { serverName: options.serverName, initialize: list.initialize };
  const findings: McpFinding[] = [];
  for (const rule of rulesFor(options.clients)) {
    if (rule.scope === "server") findings.push(...toFindings(rule, rule.check(list, context)));
    else if (rule.scope === "tool")
      for (const tool of list.tools)
        findings.push(...toFindings(rule, rule.check(tool, context), tool.name));
  }
  return findings;
}

const CLIENTS = new Set(mcpClientRules.map((rule) => rule.client));

export function rulesFor(clients: readonly McpClient[] | undefined): readonly McpClientRule[] {
  if (!clients) return mcpClientRules;
  const unknown = clients.filter((client) => !CLIENTS.has(client));
  if (unknown.length)
    throw new TypeError(
      `Unknown MCP client ${unknown.map((client) => JSON.stringify(client)).join(", ")}; expected one of ${[...CLIENTS].join(", ")}.`,
    );
  return mcpClientRules.filter((rule) => clients.includes(rule.client));
}

export function toFindings(rule: McpClientRule, hits: McpRuleHits, tool?: string): McpFinding[] {
  if (!hits) return [];
  return (Array.isArray(hits) ? hits : [hits]).map((hit) => ({
    client: rule.client,
    rule: rule.rule,
    effect: rule.effect,
    severity: rule.severity,
    confidence: hit.confidence ?? rule.confidence,
    ...(tool === undefined ? {} : { tool }),
    ...(hit.pointer ? { pointer: hit.pointer } : {}),
    message: hit.message,
    fix: hit.fix,
    source: rule.source,
    ...(hit.measured ? { measured: hit.measured } : {}),
  }));
}
