import {
  checkMcpToolList,
  MCP_CLIENT_LABELS,
  MCP_TOOL_LIST_CODES,
  mcpEndpointLabel,
  type McpCode,
  type McpDiagnostic,
  type McpFinding,
  type McpTool,
} from "@loadsheet/mcp";
import { relative } from "pathe";
import type {
  DiagnosticEvidence,
  DiagnosticLiveOrigin,
  DiagnosticOrigin,
  ProjectInfo,
  RuleContext,
  SourceRange,
} from "../../../core/index.js";
import type { DoctorDiagnosticHandle } from "../../../core/diagnostics.js";
import { canReportFromWorkspace } from "../../../core/internal/rule-execution.js";
import { sha256 } from "../../../core/internal/utils.js";
import { mcpEndpointId } from "../../../mcp/endpoint.js";
import { readMcpServers, type McpServerToolsEvidence } from "../../../mcp/evidence.js";
import type { McpToolDefinition } from "./shared.js";

interface CheckedServers {
  servers: McpServerToolsEvidence[];
  /** An MCP Rule that reads tools/list ran for the whole project. */
  projectWide: boolean;
  /** A client-limit Rule ran for the whole project, which closes the explicit-extends gap. */
  clientLimits: boolean;
  /** Servers whose tools only file overrides checked. */
  scoped: Set<McpServerToolsEvidence>;
}

const checked = new WeakMap<ProjectInfo, CheckedServers>();

export function checkedMcpServers(project: ProjectInfo) {
  const result = checked.get(project);
  return {
    projectWide: result?.projectWide ? result.servers : [],
    scoped: result?.projectWide ? [] : [...(result?.scoped ?? [])],
    clientLimits: !!result?.clientLimits,
  };
}

/** Every MCP server whose tools/list the Doctor Run read, shared by the MCP Rules. */
export function mcpServers(ctx: RuleContext): CheckedServers {
  let found = checked.get(ctx.project);
  if (!found) {
    const servers = readMcpServers(ctx.project.runtimeEvidence).filter(
      (server): server is McpServerToolsEvidence => "tools" in server,
    );
    found = { servers, projectWide: false, clientLimits: false, scoped: new Set() };
    checked.set(ctx.project, found);
  }
  return found;
}

const WITHOUT_MCP0010 = MCP_TOOL_LIST_CODES.filter((code) => code !== "MCP0010");

const results = new WeakMap<McpServerToolsEvidence, Map<string, McpDiagnostic[]>>();

/**
 * `@loadsheet/mcp`'s coded findings for one server, computed once per Doctor Run and options.
 * Without MCP0010, a tool's malformed annotations still back MCP0001 and MCP0002.
 */
export function serverDiagnostics(
  server: McpServerToolsEvidence,
  options: { withValidAnnotations?: boolean; definedTools?: readonly string[] } = {},
): McpDiagnostic[] {
  const codes = options.withValidAnnotations === false ? WITHOUT_MCP0010 : undefined;
  const key = JSON.stringify([!codes, options.definedTools ?? []]);
  let cache = results.get(server);
  if (!cache) results.set(server, (cache = new Map()));
  let found = cache.get(key);
  if (!found) {
    found = checkMcpToolList(server, {
      serverName: server.clientAlias,
      url: server.url,
      codes,
      definedTools: options.definedTools,
    }).map((diagnostic) => relabel(server, diagnostic));
    cache.set(key, found);
  }
  return found;
}

/**
 * A Doctor Extension can name a server without it being the alias clients prefix to tool names,
 * which `@loadsheet/mcp` uses as the name in its messages. Reports name the server as evidence
 * names it.
 */
function relabel(server: McpServerToolsEvidence, diagnostic: McpDiagnostic): McpDiagnostic {
  const own = server.clientAlias ?? server.initialize?.serverInfo?.name;
  const library =
    (typeof own === "string" && own ? own : undefined) ??
    (server.url === undefined ? undefined : mcpEndpointLabel(server.url)) ??
    "an MCP server";
  if (!server.name || server.name === library) return diagnostic;
  return {
    ...diagnostic,
    message: diagnostic.message.replaceAll(
      `MCP server ${JSON.stringify(library)}`,
      `MCP server ${JSON.stringify(server.name)}`,
    ),
  };
}

/** Records which servers' tools/list the running Rule checks, for the report's evidence lines. */
export function markChecked(ctx: RuleContext, sources: McpToolDefinition[]): void {
  const checked = mcpServers(ctx);
  if (checked.projectWide) return;
  if (canReportFromWorkspace(ctx)) {
    checked.projectWide = true;
    return;
  }
  for (const server of checked.servers) {
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
  /** `@loadsheet/mcp`'s coded findings for this tool. */
  diagnostics: McpDiagnostic[];
}

/**
 * Each tool the servers sent in `tools/list`, joined to its source definition by unique name.
 * A source definition that some server sent is checked on the wire only: the server shows what
 * clients receive, and source can't show what a hook or plugin changed.
 */
export function wireTools(ctx: RuleContext, sources: McpToolDefinition[]) {
  markChecked(ctx, sources);
  const tools: WireTool[] = mcpServers(ctx).servers.flatMap((server) =>
    server.tools.map((tool) => {
      const definition = staticTool(sources, tool.name);
      const withValidAnnotations = canReportFromWorkspace(
        ctx,
        definition?.file,
        "mcp/tools/valid-annotations",
      );
      return {
        server,
        tool,
        definition,
        diagnostics: serverDiagnostics(server, { withValidAnnotations }).filter(
          (diagnostic) => diagnostic.tool === tool.name,
        ),
      };
    }),
  );
  const sent = new Set(tools.flatMap((wire) => (wire.definition ? [wire.definition] : [])));
  return { tools, sourceOnly: sources.filter((source) => !sent.has(source)) };
}

/**
 * The fingerprint of a Rule's finding on a tool the source defines. The Rule's source check and
 * its check of a server's `tools/list` share it, so passing or dropping `--mcp-url` keeps the
 * finding's identity in baselines.
 */
export function definedToolFingerprint(
  ctx: RuleContext,
  ruleId: string,
  file: string,
  tool: string,
): string {
  return sha256(JSON.stringify([ruleId, relative(ctx.project.root, file), tool]));
}

/** The server a finding came from, named by its endpoint origin as the rest of the report does. */
export function liveOrigin(server: McpServerToolsEvidence): DiagnosticLiveOrigin {
  return {
    source: "mcp",
    target: server.url ? mcpEndpointLabel(server.url) : (server.name ?? "an MCP server"),
  };
}

/**
 * Reports findings at a matching definition, or at the project root. When the source also
 * has the problem, report it once with all the live observations. Live-only findings keep
 * separate identities for each endpoint, independent of which endpoints the run reads.
 */
export function reportWireTools(
  ctx: RuleContext,
  tools: WireTool[],
  code: McpCode,
  options: {
    ruleId: string;
    diagnostic: DoctorDiagnosticHandle;
    range: (definition: McpToolDefinition) => SourceRange;
    /** Whether the definition has the problem; `undefined` when the source can't tell. */
    source?: (definition: McpToolDefinition) => boolean | undefined;
  },
): void {
  const groups = new Map<string, WireFinding[]>();
  for (const wire of tools) {
    const found = wire.diagnostics.find((diagnostic) => diagnostic.code === code);
    if (!found) continue;
    const { server, tool, definition } = wire;
    const inSource = definition && options.source?.(definition);
    const endpointId = server.endpointId ?? (server.url ? mcpEndpointId(server.url) : undefined);
    const fingerprint =
      definition && inSource === true
        ? definedToolFingerprint(ctx, options.ruleId, definition.file, tool.name)
        : sha256(
            JSON.stringify([options.ruleId, server.name ?? null, endpointId ?? null, tool.name]),
          );
    const finding = { wire, found, inSource };
    const group = groups.get(fingerprint);
    if (group) group.push(finding);
    else groups.set(fingerprint, [finding]);
  }
  for (const [fingerprint, group] of groups) reportWireFinding(ctx, fingerprint, group, options);
}

interface WireFinding {
  wire: WireTool;
  found: McpDiagnostic;
  inSource: boolean | undefined;
}

function reportWireFinding(
  ctx: RuleContext,
  fingerprint: string,
  group: WireFinding[],
  options: Parameters<typeof reportWireTools>[3],
): void {
  const { wire, found, inSource } = group[0]!;
  const { server, tool, definition } = wire;
  const endpoint = server.url ? mcpEndpointLabel(server.url) : undefined;
  const range = definition ? options.range(definition) : undefined;
  const origin: DiagnosticOrigin = {
    code: !definition
      ? "no-definition"
      : inSource === true
        ? "found"
        : inSource === false
          ? "passes"
          : "not-checked",
    live: group.map(({ wire }) => liveOrigin(wire.server)),
  };
  const evidence: DiagnosticEvidence[] = [
    ...group.map(({ wire: { server } }) => {
      const endpoint = server.url ? mcpEndpointLabel(server.url) : undefined;
      const label = server.name ?? endpoint ?? "an MCP server";
      return {
        kind: "runtime" as const,
        summary: `Read from the tools/list of MCP server ${JSON.stringify(label)}${endpoint ? ` at ${endpoint}` : ""} during this Doctor Run.`,
      };
    }),
    ...citations(found.findings),
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
  ctx.report(options.diagnostic({ why: found.message, fix: found.fix }), {
    ruleId: options.ruleId,
    severity: ctx.severity,
    category: "tools",
    file: definition ? definition.file : undefined,
    projectLevel: !definition,
    range,
    fingerprint,
    instanceKey: fingerprint,
    confidence: "runtime-backed",
    origin,
    evidence,
    subject: toolSubject(ctx, server, tool.name),
    brief: found.brief,
    data: {
      server: {
        ...(server.name === undefined ? {} : { name: server.name }),
        ...(endpoint === undefined ? {} : { url: endpoint }),
      },
      tool: tool.name,
      findings: found.findings,
    },
  });
}

/**
 * Names a tool the server sent, qualified by its server when the Doctor Run read more than one.
 * Reports show it in place of a source location.
 */
export function toolSubject(
  ctx: RuleContext,
  server: McpServerToolsEvidence,
  tool: string | undefined,
): string {
  const label = server.name ?? (server.url ? mcpEndpointLabel(server.url) : "an MCP server");
  if (tool === undefined) return `MCP server ${JSON.stringify(label)}`;
  return mcpServers(ctx).servers.length > 1 ? `${tool} (${label})` : tool;
}

/**
 * Evidence that cites the client source behind each finding once. The verbatim quote stays in
 * the Diagnostic's `data.findings[].source.quote`.
 */
export function citations(findings: readonly McpFinding[]): DiagnosticEvidence[] {
  const summaries = new Set(
    findings.map(
      (finding) =>
        `${MCP_CLIENT_LABELS[finding.client]} (${finding.rule}): ${finding.source.url}, ${finding.source.kind} checked ${finding.source.checked}`,
    ),
  );
  return [...summaries].map((summary) => ({ kind: "runtime", summary }));
}
