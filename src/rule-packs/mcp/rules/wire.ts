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
  /** A client-limit Rule ran for the whole project, which closes the explicit-extends gap. */
  clientLimits: boolean;
  /** Servers whose tools only file overrides checked. */
  scoped: Set<McpServerToolsEvidence>;
}

const checked = new WeakMap<ProjectInfo, CheckedServers>();

export function checkedMcpServers(project: ProjectInfo) {
  const result = checked.get(project);
  return {
    projectWide: result?.projectWide ? result.servers.map(({ server }) => server) : [],
    scoped: result?.projectWide ? [] : [...(result?.scoped ?? [])],
    clientLimits: !!result?.clientLimits,
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
    found = { servers, projectWide: false, clientLimits: false, scoped: new Set() };
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
    server.tools.map((tool) => {
      const definition = staticTool(sources, tool.name);
      // When MCP0010 explains annotations that aren't ToolAnnotations, a missing title or hint in
      // them would point the author at the wrong fix.
      const replaced =
        !!annotationsProblem(tool) &&
        canReportFromWorkspace(ctx, definition?.file, "mcp/tools/valid-annotations");
      return {
        server,
        tool,
        definition,
        findings: findings.filter(
          (finding) =>
            finding.tool === tool.name &&
            !(replaced && finding.pointer?.startsWith("/annotations")),
        ),
      };
    }),
  );
  const sent = new Set(tools.flatMap((wire) => (wire.definition ? [wire.definition] : [])));
  return { tools, sourceOnly: sources.filter((source) => !sent.has(source)) };
}

const ANNOTATION_TYPES: Record<string, string> = {
  title: "string",
  readOnlyHint: "boolean",
  destructiveHint: "boolean",
  idempotentHint: "boolean",
  openWorldHint: "boolean",
};

const SDK_REJECTS =
  "The MCP TypeScript SDK's client rejects the whole tools/list response when it can't parse a tool's annotations, so clients built on it get none of the tools on that page, or none at all when the server sends one page.";

export interface AnnotationsProblem {
  why: string;
  /** The annotations hold a serialized schema, so the input schema likely went missing too. */
  schema: boolean;
}

/**
 * How a tool's `annotations` fail to be ToolAnnotations, checked the way the MCP SDK's client
 * parses them: an object whose known fields have their declared types. Unknown fields are allowed
 * and dropped, so only keys a serialized schema carries count against them.
 */
export function annotationsProblem(tool: McpTool): AnnotationsProblem | undefined {
  if (tool.annotations === undefined) return;
  const annotations: unknown = tool.annotations;
  if (annotations === null || typeof annotations !== "object" || Array.isArray(annotations)) {
    const kind =
      annotations === null
        ? "null"
        : Array.isArray(annotations)
          ? "an array"
          : `a ${typeof annotations}`;
    return {
      why: `sends \`annotations\` as ${kind}, not an object. ${SDK_REJECTS}`,
      schema: false,
    };
  }
  const record = annotations as Record<string, unknown>;
  const wrong = Object.entries(ANNOTATION_TYPES).flatMap(([key, type]) =>
    key in record && typeof record[key] !== type
      ? [`\`${key}\` to ${valueKind(record[key])} instead of a ${type}`]
      : [],
  );
  if (wrong.length) {
    return {
      why: `sets ${wrong.join(", ")} in \`annotations\`. ${SDK_REJECTS}`,
      schema: false,
    };
  }
  const markers = ["_def", "~standard", "_zod"].filter((key) => key in record);
  // Zod 4 schemas serialize to their `def`, whose `type` repeats at the top level.
  const def = record.def as Record<string, unknown> | null | undefined;
  if (
    typeof record.type === "string" &&
    def &&
    typeof def === "object" &&
    def.type === record.type
  ) {
    markers.push("def");
  }
  if (!markers.length) return;
  return {
    why: `sends a serialized schema as \`annotations\` (it has ${markers.map((key) => `\`${key}\``).join(", ")}). Clients drop the fields \`ToolAnnotations\` doesn't define, so the tool reaches them with no title or safety hints.`,
    schema: true,
  };
}

function valueKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const type = typeof value;
  return type === "object" ? "an object" : `a ${type}`;
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
    /** The Rule's one-line row for this tool, such as `no annotations.title`. */
    brief: string;
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
    ...citations(options.findings),
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
    subject: toolSubject(ctx, server, tool.name),
    brief: options.brief,
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
  return serverFindings(ctx).servers.length > 1 ? `${tool} (${label})` : tool;
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
