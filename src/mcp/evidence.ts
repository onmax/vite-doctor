import type { DoctorExtension, ProjectInfo } from "../core/primitives.js";
import { fetchMcpToolList, McpFetchError } from "./fetch.js";
import type { McpInitializeResult, McpTool } from "./types.js";

/** The name of Doctor's own Runtime Evidence contributor for MCP servers. */
export const MCP_EVIDENCE = "mcp";

/** An MCP server Doctor reads `tools/list` from during a Doctor Run. */
export interface McpServerTarget {
  /** Streamable HTTP endpoint of the server. */
  url: string;
  /** Request headers, such as `authorization`. They never reach a report. */
  headers?: Record<string, string>;
  /** How reports name the server. Defaults to the `serverInfo.name` the server sends, then the URL. */
  serverName?: string;
}

/** The `tools/list` a client sees when it connects to one MCP server. */
export interface McpServerToolsEvidence {
  name?: string;
  url?: string;
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
  return (
    Array.isArray(server.tools) &&
    server.tools.every(
      (tool) => tool && typeof tool === "object" && typeof (tool as McpTool).name === "string",
    )
  );
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
  try {
    const list = await fetchMcpToolList(url, { headers, ...options });
    const name = serverName ?? list.initialize?.serverInfo?.name;
    return { ...(name ? { name } : {}), url, ...list };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const status = error instanceof McpFetchError ? error.status : undefined;
    const hint =
      status === 401 || status === 403
        ? ' On the CLI, pass it with --mcp-header "Authorization: Bearer <token>".'
        : "";
    project.evidenceGaps = [
      ...(project.evidenceGaps ?? []),
      {
        source: MCP_EVIDENCE,
        message: `Doctor could not read the tools of the MCP server at ${url}, so its tools were not checked: ${reason}${hint}`,
        files: [],
      },
    ];
    return {
      ...(serverName ? { name: serverName } : {}),
      url,
      error: reason,
      ...(status === undefined ? {} : { status }),
    };
  }
}

/** A Doctor Run has no server to resolve a path against, so an MCP URL must be absolute. */
export function assertAbsoluteMcpUrl(url: string): void {
  const protocol = URL.parse(url)?.protocol;
  if (protocol === "http:" || protocol === "https:") return;
  throw new Error(
    `MCP server URL ${JSON.stringify(url)} is not an absolute http(s) URL. Pass the full endpoint, such as http://localhost:3000/mcp; only the Vite plugin in dev resolves a path against its own dev server.`,
  );
}

/**
 * MCP Runtime Evidence that no Rule checked because the MCP Rule Pack is not selected. Reported
 * as an evidence gap so a run that read a server's tools never looks clean for them.
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
  const names = servers.map((server) => server.url ?? server.name ?? "an MCP server").join(", ");
  return {
    source: MCP_EVIDENCE,
    message: `Doctor read the tools of ${names} as Runtime Evidence but did not check them: the vite-doctor/mcp Rule Pack is not selected, because no MCP package is in the project or the selected Presets leave it out. Add "mcp/recommended" to extends to check them.`,
    files: [],
  };
}
