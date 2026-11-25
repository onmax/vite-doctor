import { resolve } from "pathe";
import type {
  Confidence,
  DiagnosticEvidence,
  DoctorSeverity,
  RuleContext,
  RuleVisitor,
  SourceRange,
} from "../../../core/index.js";
import type { DoctorDiagnosticHandle } from "../../../core/diagnostics.js";
import { projectWorkspacePackages } from "../../../core/internal/applicability.js";
import { sha256 } from "../../../core/internal/utils.js";
import { checkMcpToolList } from "../../../mcp/check.js";
import { readMcpServers, type McpServerToolsEvidence } from "../../../mcp/evidence.js";
import type { McpClient, McpEffect, McpFinding } from "../../../mcp/types.js";
import { collectMcpTools, MCP_PACKAGES, type McpToolDefinition } from "./shared.js";
import { nameProblems } from "./valid-name.js";

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

export interface ClientLimitOptions {
  ruleId: string;
  diagnostic: DoctorDiagnosticHandle;
  effect: McpEffect;
  /** Completes "Tool `x` of MCP server "y" …" and "MCP server "y" …", such as "is left out". */
  outcome: string;
}

interface ServerFindings {
  server: McpServerToolsEvidence;
  findings: McpFinding[];
}

const checked = new WeakMap<object, ServerFindings[]>();

/** Every MCP server's findings, checked once per Doctor Run and shared by the client-limit Rules. */
function serverFindings(ctx: RuleContext): ServerFindings[] {
  let found = checked.get(ctx.project);
  if (!found) {
    found = readMcpServers(ctx.project.runtimeEvidence)
      .filter((server): server is McpServerToolsEvidence => "tools" in server)
      .map((server) => ({
        server,
        findings: checkMcpToolList(server, { serverName: server.name }),
      }));
    checked.set(ctx.project, found);
  }
  return found;
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
      const groups = serverFindings(ctx).flatMap(({ server, findings }) =>
        groupByTool(
          server,
          findings.filter((finding) => finding.effect === options.effect),
        ),
      );
      if (!groups.length) return;
      const tools = await collectMcpTools(ctx);
      for (const group of groups) {
        const definition = group.tool === undefined ? undefined : staticTool(tools, group.tool);
        const findings = definition?.name
          ? group.findings.filter((finding) => !repeatsValidName(finding, definition.name!.value))
          : group.findings;
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

/** The tool's definition in source, when exactly one has the name the server sends. */
function staticTool(tools: McpToolDefinition[], name: string): McpToolDefinition | undefined {
  const matches = tools.filter((tool) => tool.name?.value === name);
  return matches.length === 1 ? matches[0] : undefined;
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
  const label = server.name ?? server.initialize?.serverInfo?.name ?? server.url ?? "an MCP server";
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
      summary: `Read from the tools/list of MCP server ${JSON.stringify(label)}${server.url ? ` at ${server.url}` : ""} during this Doctor Run.`,
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
      file: definition && range ? definition.file : fallbackAnchor(ctx),
      range: definition && range ? range : undefined,
      // Without a source location, the server and tool identify the Diagnostic across runs.
      fingerprint:
        definition && range
          ? undefined
          : sha256(
              JSON.stringify([
                options.ruleId,
                server.name ?? null,
                server.url ?? null,
                tool ?? null,
              ]),
            ),
      confidence,
      evidence,
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

/**
 * The root of the one workspace package that depends on an MCP package, else the project root,
 * for a Diagnostic whose tool has no definition in source.
 */
function fallbackAnchor(ctx: RuleContext): string {
  const owners = projectWorkspacePackages(ctx.project).filter((item) =>
    MCP_PACKAGES.some((name) => name in item.packages),
  );
  const owner = owners.length === 1 ? owners[0]!.root : ".";
  return resolve(ctx.project.root, owner);
}
