import { relative } from "pathe";
import type {
  DiagnosticEvidence,
  ProjectInfo,
  RuleContext,
  SourceRange,
} from "../../../core/index.js";
import type { Diagnostic as NosticsDiagnostic } from "nostics";
import { canReportFromWorkspace } from "../../../core/internal/rule-execution.js";
import { sha256 } from "../../../core/internal/utils.js";
import { checkMcpToolList } from "../../../mcp/check.js";
import { mcpEndpointId, mcpEndpointLabel } from "../../../mcp/endpoint.js";
import { readMcpServers, type McpServerToolsEvidence } from "../../../mcp/evidence.js";
import type { McpClient, McpFinding, McpTool } from "../../../mcp/types.js";
import type { McpToolDefinition } from "./shared.js";

export const MCP_CLIENT_LABELS: Record<McpClient, string> = {
  "claude-code": "Claude Code",
  claude: "Claude",
  "claude-directory": "Anthropic's Connectors Directory",
  chatgpt: "ChatGPT",
  codex: "Codex",
  cursor: "Cursor",
  vscode: "VS Code",
  "gemini-cli": "Gemini CLI",
  "copilot-studio": "Copilot Studio",
};

export interface ServerFindings {
  server: McpServerToolsEvidence;
  findings: McpFinding[];
}

interface CheckedServers {
  servers: ServerFindings[];
  /** An MCP Rule that reads tools/list ran for the whole project. */
  projectWide: boolean;
  /** Servers whose tools only file overrides checked. */
  scoped: Set<McpServerToolsEvidence>;
}

const checked = new WeakMap<ProjectInfo, CheckedServers>();

export function checkedMcpServers(project: ProjectInfo) {
  const result = checked.get(project);
  return {
    projectWide: result?.projectWide ? result.servers.map(({ server }) => server) : [],
    scoped: result?.projectWide ? [] : [...(result?.scoped ?? [])],
  };
}

/** Every MCP server's findings, checked once per Doctor Run and shared by the MCP Rules. */
export function serverFindings(ctx: RuleContext): CheckedServers {
  let found = checked.get(ctx.project);
  if (!found) {
    const servers = readMcpServers(ctx.project.runtimeEvidence)
      .filter((server): server is McpServerToolsEvidence => "tools" in server)
      .map((server) => ({
        server,
        findings: checkMcpToolList(server, { serverName: server.clientAlias }),
      }));
    found = { servers, projectWide: false, scoped: new Set() };
    checked.set(ctx.project, found);
  }
  return found;
}

/** Records which servers' tools/list the running Rule checks, for the report's evidence lines. */
export function markChecked(ctx: RuleContext, sources: McpToolDefinition[]): void {
  const checked = serverFindings(ctx);
  if (checked.projectWide) return;
  if (canReportFromWorkspace(ctx)) {
    checked.projectWide = true;
    return;
  }
  for (const { server } of checked.servers) {
    if (
      server.tools.some(({ name }) => {
        const definition = staticTool(sources, name);
        return definition && canReportFromWorkspace(ctx, definition.file);
      })
    ) {
      checked.scoped.add(server);
    }
  }
}

/** The tool's definition in source, when exactly one has the name the server sends. */
export function staticTool(
  tools: McpToolDefinition[],
  name: string,
): McpToolDefinition | undefined {
  const matches = tools.filter((tool) => tool.name?.value === name);
  return matches.length === 1 ? matches[0] : undefined;
}

export interface WireTool {
  server: McpServerToolsEvidence;
  tool: McpTool;
  definition?: McpToolDefinition;
  /** The library's findings for this tool, from every client. */
  findings: McpFinding[];
}

/**
 * Each tool the servers sent in `tools/list`, joined to its source definition by unique name.
 * A source definition that some server sent is checked on the wire only: the server shows what
 * clients receive, and source can't show what a hook or plugin changed.
 */
export function wireTools(ctx: RuleContext, sources: McpToolDefinition[]) {
  markChecked(ctx, sources);
  const tools: WireTool[] = serverFindings(ctx).servers.flatMap(({ server, findings }) =>
    server.tools.map((tool) => ({
      server,
      tool,
      definition: staticTool(sources, tool.name),
      findings: findings.filter((finding) => finding.tool === tool.name),
    })),
  );
  const sent = new Set(tools.flatMap((wire) => (wire.definition ? [wire.definition] : [])));
  return { tools, sourceOnly: sources.filter((source) => !sent.has(source)) };
}

/**
 * Reports a tool the server sent, at its source definition when one matches and at the project
 * root otherwise. The fingerprint uses the endpoint, not its URL, so it stays stable when only
 * the port or host changes.
 */
export function reportWireTool(
  ctx: RuleContext,
  wire: WireTool,
  diagnostic: NosticsDiagnostic,
  options: {
    ruleId: string;
    range: (definition: McpToolDefinition) => SourceRange;
    findings: McpFinding[];
  },
): void {
  const { server, tool, definition } = wire;
  const endpoint = server.url ? mcpEndpointLabel(server.url) : undefined;
  const endpointId = server.endpointId ?? (server.url ? mcpEndpointId(server.url) : undefined);
  const label = server.name ?? endpoint ?? "an MCP server";
  const range = definition ? options.range(definition) : undefined;
  const anchor = endpointId ?? (definition ? relative(ctx.project.root, definition.file) : null);
  const fingerprint = sha256(
    JSON.stringify([options.ruleId, server.name ?? null, anchor, tool.name]),
  );
  const evidence: DiagnosticEvidence[] = [
    {
      kind: "runtime",
      summary: `Read from the tools/list of MCP server ${JSON.stringify(label)}${endpoint ? ` at ${endpoint}` : ""} during this Doctor Run.`,
    },
    ...options.findings.map((finding) => ({
      kind: "runtime" as const,
      summary: `${MCP_CLIENT_LABELS[finding.client]} (${finding.rule}): ${finding.source.url}, ${finding.source.kind} checked ${finding.source.checked}: "${finding.source.quote}"`,
    })),
    ...(definition && range
      ? [
          {
            kind: "ast" as const,
            file: definition.file,
            range,
            summary: `The source defines the tool ${JSON.stringify(tool.name)} here.`,
          },
        ]
      : []),
  ];
  ctx.report(diagnostic, {
    ruleId: options.ruleId,
    severity: ctx.severity,
    category: "tools",
    file: definition ? definition.file : undefined,
    projectLevel: !definition,
    range,
    fingerprint,
    instanceKey: endpointId ? fingerprint : undefined,
    confidence: "runtime-backed",
    evidence,
    data: {
      server: {
        ...(server.name === undefined ? {} : { name: server.name }),
        ...(endpoint === undefined ? {} : { url: endpoint }),
      },
      tool: tool.name,
      findings: options.findings,
    },
  });
}

/** How a Diagnostic names a tool the server sent. */
export function wireToolLabel(wire: WireTool): string {
  const { server } = wire;
  const label = server.name ?? (server.url ? mcpEndpointLabel(server.url) : "an MCP server");
  return `${JSON.stringify(wire.tool.name)} of MCP server ${JSON.stringify(label)}`;
}
