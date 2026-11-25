import type { DoctorExtension, ProjectInfo } from "../core/primitives.js";
import { mcpEndpointId, mcpEndpointLabel, parseMcpEndpoint } from "./endpoint.js";
import { fetchMcpToolList, McpFetchError } from "./fetch.js";
import { isMcpTool } from "./input.js";
import type { McpInitializeResult, McpTool } from "./types.js";

/** The name of Doctor's own Runtime Evidence contributor for MCP servers. */
export const MCP_EVIDENCE = "mcp";

/** An MCP server Doctor reads `tools/list` from during a Doctor Run. */
export interface McpServerTarget {
  /** Streamable HTTP endpoint of the server. */
  url: string;
  /** Request headers, such as `authorization`. They never reach a report. */
  headers?: Record<string, string>;
  /** Client-configured alias, also used in reports when provided. */
  serverName?: string;
}

/** The `tools/list` a client sees when it connects to one MCP server. */
export interface McpServerToolsEvidence {
  name?: string;
  url?: string;
  /** Opaque endpoint identity when `url` is only a redacted display label. */
  endpointId?: string;
  /** Client-configured alias, not the name announced in `initialize`. */
  clientAlias?: string;
  initialize?: McpInitializeResult;
  tools: McpTool[];
}

/** An MCP server whose `tools/list` could not be read. */
export interface McpServerErrorEvidence {
  name?: string;
  url: string;
  error: string;
  status?: number;
}

export type McpServerEvidence = McpServerToolsEvidence | McpServerErrorEvidence;

/**
 * Every MCP server any Runtime Evidence contributor reported as `{ mcpServers }`, so Doctor's own
 * `mcp` contributor, ViteHub, and other Doctor Extensions feed the same checks.
 */
export function readMcpServers(
  runtimeEvidence: Record<string, unknown> | undefined,
): McpServerEvidence[] {
  return Object.values(runtimeEvidence ?? {}).flatMap((entry) => {
    const servers = (entry as { mcpServers?: unknown } | null | undefined)?.mcpServers;
    return Array.isArray(servers) ? servers.filter(isMcpServerEvidence) : [];
  });
}

// Any Doctor Extension can contribute this evidence, so only well-formed entries are read.
function isMcpServerEvidence(value: unknown): value is McpServerEvidence {
  if (!value || typeof value !== "object") return false;
  const server = value as Partial<McpServerToolsEvidence & McpServerErrorEvidence>;
  if (typeof server.error === "string") return typeof server.url === "string";
  return Array.isArray(server.tools) && server.tools.every(isMcpTool);
}

/**
 * Doctor Extension that reads `tools/list` from each configured server as `mcp` Runtime Evidence.
 * A server Doctor cannot read leaves an evidence gap, so the report is `incomplete` rather than
 * clean.
 */
export function mcpEvidenceExtension(
  targets: readonly McpServerTarget[],
  options: { fetch?: typeof globalThis.fetch; timeout?: number } = {},
): DoctorExtension {
  for (const target of targets) assertAbsoluteMcpUrl(target.url);
  return {
    name: "vite-doctor/mcp-evidence",
    setup(api) {
      api.registerRuntimeEvidenceContributor({
        name: MCP_EVIDENCE,
        async contribute(project) {
          const mcpServers = await Promise.all(
            targets.map((target) => readServer(project, target, options)),
          );
          return { mcpServers };
        },
      });
    },
  };
}

async function readServer(
  project: ProjectInfo,
  { url, headers, serverName }: McpServerTarget,
  options: { fetch?: typeof globalThis.fetch; timeout?: number },
): Promise<McpServerEvidence> {
  const label = mcpEndpointLabel(url);
  const endpointId = mcpEndpointId(url);
  try {
    const list = await fetchMcpToolList(url, { headers, ...options });
    const name = serverName ?? list.initialize?.serverInfo?.name;
    return {
      ...(name ? { name } : {}),
      ...(serverName ? { clientAlias: serverName } : {}),
      url: label,
      endpointId,
      ...list,
    };
  } catch (error) {
    const reason = error instanceof McpFetchError ? error.message : "The request failed.";
    const status = error instanceof McpFetchError ? error.status : undefined;
    const hint =
      status === 401 || status === 403
        ? ' On the CLI, pass it with --mcp-header "Authorization: Bearer <token>".'
        : "";
    project.evidenceGaps = [
      ...(project.evidenceGaps ?? []),
      {
        source: MCP_EVIDENCE,
        message: `Doctor could not read the tools of the MCP server at ${label}, so its tools were not checked: ${reason}${hint}`,
        files: [],
        instanceKey: endpointId,
      },
    ];
    return {
      ...(serverName ? { name: serverName } : {}),
      url: label,
      error: reason,
      ...(status === undefined ? {} : { status }),
    };
  }
}

/** A Doctor Run has no server to resolve a path against, so an MCP URL must be absolute. */
export function assertAbsoluteMcpUrl(url: string): void {
  if (parseMcpEndpoint(url)) return;
  throw new Error(
    "The MCP server URL is not an absolute http(s) URL. Pass the full endpoint, such as http://localhost:3000/mcp; only the Vite plugin in dev resolves a path against its own dev server.",
  );
}

/** One line per MCP server whose `tools/list` the run read, so a clean report names what it covered. */
export function mcpEvidenceUsed(project: ProjectInfo): NonNullable<ProjectInfo["evidenceUsed"]> {
  return readMcpServers(project.runtimeEvidence)
    .filter((server): server is McpServerToolsEvidence => "tools" in server)
    .map((server) => {
      const label = server.url ? mcpEndpointLabel(server.url) : (server.name ?? "an MCP server");
      const count = `${server.tools.length} ${server.tools.length === 1 ? "tool" : "tools"}`;
      return {
        source: MCP_EVIDENCE,
        message: `tools/list of the MCP server at ${label}, ${count}`,
      };
    });
}

/**
 * MCP Runtime Evidence that no Rule checked because an explicit extends list leaves the MCP Rule
 * Pack out; the evidence itself activates it. Reported as an evidence gap so a run that read a
 * server's tools never looks clean for them.
 */
export function uncheckedMcpEvidenceGap(
  project: ProjectInfo,
  mcpPackSelected: boolean,
): NonNullable<ProjectInfo["evidenceGaps"]>[number] | undefined {
  if (mcpPackSelected) return undefined;
  const servers = readMcpServers(project.runtimeEvidence).filter(
    (server): server is McpServerToolsEvidence => "tools" in server,
  );
  if (!servers.length) return undefined;
  const names = servers
    .map((server) => (server.url ? mcpEndpointLabel(server.url) : (server.name ?? "an MCP server")))
    .join(", ");
  return {
    source: MCP_EVIDENCE,
    message: `Doctor read the tools of ${names} as Runtime Evidence but did not check them: the extends list leaves out the vite-doctor/mcp Rule Pack. Add "auto", or "mcp/recommended" ("mcp/strict" for the Strict Preset), to the selectors you already have; a CLI --extends replaces the configured list, so repeat them there.`,
    files: [],
  };
}
