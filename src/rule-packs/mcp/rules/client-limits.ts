import type { McpCode, McpDiagnostic } from "@loadsheet/mcp";
import { mcpEndpointLabel } from "@loadsheet/mcp";
import { relative, resolve } from "pathe";
import type {
  DiagnosticEvidence,
  DoctorSeverity,
  RuleContext,
  RuleVisitor,
  SourceRange,
} from "../../../core/index.js";
import type { DoctorDiagnosticHandle } from "../../../core/diagnostics.js";
import { canReportFromWorkspace } from "../../../core/internal/rule-execution.js";
import { projectWorkspacePackages } from "../../../core/internal/applicability.js";
import { sha256 } from "../../../core/internal/utils.js";
import { mcpEndpointId } from "../../../mcp/endpoint.js";
import type { McpServerToolsEvidence } from "../../../mcp/evidence.js";
import { collectMcpTools, MCP_PACKAGES, type McpToolDefinition } from "./shared.js";
import {
  citations,
  markChecked,
  mcpServers,
  serverDiagnostics,
  staticTool,
  toolSubject,
} from "./wire.js";

export interface ClientLimitOptions {
  ruleId: string;
  code: McpCode;
  diagnostic: DoctorDiagnosticHandle;
}

/**
 * Reports, for each MCP server and tool, `@loadsheet/mcp`'s finding for `code`: one Diagnostic
 * listing every client that applies the code's effect to it, with the worst severity and the
 * lowest confidence of its client findings, so neither overstates what a client does.
 */
export function clientLimitsVisitor(ctx: RuleContext, options: ClientLimitOptions): RuleVisitor {
  return {
    async onWorkspaceEnd() {
      const checked = mcpServers(ctx);
      if (canReportFromWorkspace(ctx)) checked.projectWide = checked.clientLimits = true;
      const found = checked.servers.some((server) =>
        serverDiagnostics(server).some((diagnostic) => diagnostic.code === options.code),
      );
      if (!found && (checked.projectWide || !checked.servers.length)) return;
      const tools = mcpPackageTools(ctx, await collectMcpTools(ctx));
      markChecked(ctx, tools);
      const definedTools = tools.flatMap((tool) =>
        tool.name && staticTool(tools, tool.name.value) ? [tool.name.value] : [],
      );
      for (const server of checked.servers) {
        for (const diagnostic of serverDiagnostics(server, { definedTools })) {
          if (diagnostic.code !== options.code) continue;
          const definition =
            diagnostic.tool === undefined ? undefined : staticTool(tools, diagnostic.tool);
          report(ctx, options, server, diagnostic, definition);
        }
      }
    },
  };
}

/**
 * Definitions in workspace packages that depend on an MCP package. These Rules run across the
 * workspace, and a tool of the same name in another package is not the one the server sends.
 * Without such a package, nothing ties the server to this project's source.
 */
function mcpPackageTools(ctx: RuleContext, tools: McpToolDefinition[]): McpToolDefinition[] {
  const packages = projectWorkspacePackages(ctx.project).map((item) => ({
    root: resolve(ctx.project.root, item.root),
    mcp: MCP_PACKAGES.some((name) => name in item.packages),
  }));
  if (!packages.some((item) => item.mcp)) return [];
  return tools.filter((tool) => {
    const owner = packages
      .filter((item) => tool.file.startsWith(`${item.root}/`))
      .sort((left, right) => right.root.length - left.root.length)[0];
    return owner?.mcp ?? false;
  });
}

function report(
  ctx: RuleContext,
  options: ClientLimitOptions,
  server: McpServerToolsEvidence,
  found: McpDiagnostic,
  definition: McpToolDefinition | undefined,
): void {
  const { tool, findings } = found;
  const endpoint = server.url ? mcpEndpointLabel(server.url) : undefined;
  const endpointId = server.endpointId ?? (server.url ? mcpEndpointId(server.url) : undefined);
  const name = server.name ?? server.initialize?.serverInfo?.name;
  const locations = new Set(
    findings.flatMap(({ rule, pointer, affectedPointers }) =>
      (affectedPointers ?? [pointer ?? null]).map((location) => JSON.stringify([rule, location])),
    ),
  );
  const anchor =
    endpointId ?? (definition?.name?.range ? relative(ctx.project.root, definition.file) : null);
  const fingerprint = sha256(
    JSON.stringify([options.ruleId, name ?? null, anchor, tool ?? null, [...locations].sort()]),
  );
  const label = name ?? endpoint ?? "an MCP server";
  const range: SourceRange | undefined = definition?.name?.range;
  const evidence: DiagnosticEvidence[] = [
    {
      kind: "runtime",
      summary: `Read from the tools/list of MCP server ${JSON.stringify(label)}${endpoint ? ` at ${endpoint}` : ""} during this Doctor Run.`,
    },
    ...citations(findings),
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
  ctx.report(options.diagnostic({ why: found.message, fix: found.fix }), {
    ruleId: options.ruleId,
    severity: found.severity satisfies DoctorSeverity,
    category: "clients",
    file: definition && range ? definition.file : undefined,
    projectLevel: !definition || !range,
    range: definition && range ? range : undefined,
    fingerprint,
    instanceKey: endpointId ? fingerprint : undefined,
    confidence: found.confidence === "medium" ? "heuristic-medium" : "runtime-backed",
    evidence,
    subject: toolSubject(ctx, server, tool),
    brief: found.brief,
    data: {
      server: {
        ...(name === undefined ? {} : { name }),
        ...(endpoint === undefined ? {} : { url: endpoint }),
      },
      ...(tool === undefined ? {} : { tool }),
      findings,
    },
  });
}
