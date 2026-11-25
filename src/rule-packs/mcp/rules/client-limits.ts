import { relative } from "pathe";
import type {
  Confidence,
  DiagnosticEvidence,
  DoctorSeverity,
  RuleContext,
  RuleVisitor,
  SourceRange,
} from "../../../core/index.js";
import type { DoctorDiagnosticHandle } from "../../../core/diagnostics.js";
import { canReportFromWorkspace } from "../../../core/internal/rule-execution.js";
import { sha256 } from "../../../core/internal/utils.js";
import { mcpEndpointId, mcpEndpointLabel } from "../../../mcp/endpoint.js";
import type { McpServerToolsEvidence } from "../../../mcp/evidence.js";
import type { McpEffect, McpFinding } from "../../../mcp/types.js";
import { collectMcpTools, type McpToolDefinition } from "./shared.js";
import { nameProblems } from "./valid-name.js";
import { MCP_CLIENT_LABELS, serverFindings, staticTool } from "./wire.js";

export interface ClientLimitOptions {
  ruleId: string;
  diagnostic: DoctorDiagnosticHandle;
  effect: McpEffect;
  /** Completes "Tool `x` of MCP server "y" …" and "MCP server "y" …", such as "is left out". */
  outcome: string;
}

const SEVERITY_RANK: Record<McpFinding["severity"], number> = { info: 0, warn: 1, error: 2 };

/**
 * Reports, for each MCP server and tool, one Diagnostic listing every client that applies the
 * given effect to it. The Diagnostic takes the worst severity and the lowest confidence of its
 * findings, so neither overstates what a client does.
 */
export function clientLimitsVisitor(ctx: RuleContext, options: ClientLimitOptions): RuleVisitor {
  return {
    async onWorkspaceEnd() {
      const checked = serverFindings(ctx);
      if (canReportFromWorkspace(ctx)) checked.projectWide = true;
      const groups = checked.servers.flatMap(({ server, findings }) =>
        groupByTool(
          server,
          findings.filter((finding) => finding.effect === options.effect),
        ),
      );
      if (!groups.length && (checked.projectWide || !checked.servers.length)) return;
      const tools = await collectMcpTools(ctx);
      if (!checked.projectWide) {
        for (const { server } of checked.servers) {
          if (
            server.tools.some(({ name }) => {
              const definition = staticTool(tools, name);
              return definition && canReportFromWorkspace(ctx, definition.file);
            })
          ) {
            checked.scoped.add(server);
          }
        }
      }
      for (const group of groups) {
        const definition = group.tool === undefined ? undefined : staticTool(tools, group.tool);
        const name = definition?.name?.value;
        const findings =
          name === undefined
            ? group.findings
            : group.findings.filter((finding) => !repeatsValidName(finding, name));
        if (findings.length) report(ctx, options, group.server, group.tool, findings, definition);
      }
    },
  };
}

function groupByTool(server: McpServerToolsEvidence, findings: McpFinding[]) {
  const byTool = new Map<string | undefined, McpFinding[]>();
  for (const finding of findings)
    byTool.set(finding.tool, [...(byTool.get(finding.tool) ?? []), finding]);
  return [...byTool].map(([tool, grouped]) => ({ server, tool, findings: grouped }));
}

// MCP0003 already asks to rename a tool whose name breaks MCP's rules; a client renaming that
// same name says nothing the fix doesn't cover.
function repeatsValidName(finding: McpFinding, name: string): boolean {
  return (
    finding.effect === "rewritten" && finding.pointer === "/name" && nameProblems(name).length > 0
  );
}

function report(
  ctx: RuleContext,
  options: ClientLimitOptions,
  server: McpServerToolsEvidence,
  tool: string | undefined,
  findings: McpFinding[],
  definition: McpToolDefinition | undefined,
): void {
  const endpoint = server.url ? mcpEndpointLabel(server.url) : undefined;
  const endpointId = server.endpointId ?? (server.url ? mcpEndpointId(server.url) : undefined);
  const locations = new Set(
    findings.flatMap(({ rule, pointer, affectedPointers }) =>
      (affectedPointers ?? [pointer ?? null]).map((location) => JSON.stringify([rule, location])),
    ),
  );
  const anchor =
    endpointId ?? (definition?.name?.range ? relative(ctx.project.root, definition.file) : null);
  const fingerprint = sha256(
    JSON.stringify([
      options.ruleId,
      server.name ?? null,
      anchor,
      tool ?? null,
      [...locations].sort(),
    ]),
  );
  const label = server.name ?? endpoint ?? "an MCP server";
  const subject =
    tool === undefined
      ? `MCP server ${JSON.stringify(label)}`
      : `Tool \`${tool}\` of MCP server ${JSON.stringify(label)}`;
  const clients = [...new Set(findings.map((finding) => MCP_CLIENT_LABELS[finding.client]))];
  const details = findings.map((finding) => `${finding.message}${measured(finding)}`).join(" ");
  const severity = findings.reduce<McpFinding["severity"]>(
    (worst, finding) =>
      SEVERITY_RANK[finding.severity] > SEVERITY_RANK[worst] ? finding.severity : worst,
    "info",
  );
  const confidence: Confidence = findings.some((finding) => finding.confidence === "medium")
    ? "heuristic-medium"
    : "runtime-backed";
  const range: SourceRange | undefined = definition?.name?.range;
  const evidence: DiagnosticEvidence[] = [
    {
      kind: "runtime",
      summary: `Read from the tools/list of MCP server ${JSON.stringify(label)}${endpoint ? ` at ${endpoint}` : ""} during this Doctor Run.`,
    },
    ...findings.map((finding) => ({
      kind: "runtime" as const,
      summary: `${MCP_CLIENT_LABELS[finding.client]} (${finding.rule}${finding.pointer ? ` at ${finding.pointer}` : ""}): ${finding.source.url}, ${finding.source.kind} checked ${finding.source.checked}: "${finding.source.quote}"`,
    })),
    ...(definition && range
      ? [
          {
            kind: "ast" as const,
            file: definition.file,
            range,
            summary: `The source defines the tool ${JSON.stringify(tool)} here.`,
          },
        ]
      : []),
  ];
  ctx.report(
    options.diagnostic({
      why: `${subject} ${options.outcome} in ${list(clients)}. ${details}`,
      fix: [...new Set(findings.map((finding) => finding.fix))].join(" "),
    }),
    {
      ruleId: options.ruleId,
      severity: severity satisfies DoctorSeverity,
      category: "clients",
      file: definition && range ? definition.file : undefined,
      projectLevel: !definition || !range,
      range: definition && range ? range : undefined,
      fingerprint,
      instanceKey: endpointId ? fingerprint : undefined,
      confidence,
      evidence,
      data: {
        server: {
          ...(server.name === undefined ? {} : { name: server.name }),
          ...(endpoint === undefined ? {} : { url: endpoint }),
        },
        ...(tool === undefined ? {} : { tool }),
        findings,
      },
    },
  );
}

function measured(finding: McpFinding): string {
  const value = finding.measured;
  return value ? ` Measured: ${value.value} ${value.unit}, limit ${value.limit}.` : "";
}

function list(items: string[]): string {
  if (items.length < 3) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}
