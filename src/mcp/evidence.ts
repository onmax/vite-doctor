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
  /**
   * The name clients know the server by, such as its key in `.mcp.json`, which they prefix to tool
   * names. Without it, reports name the server by the `serverInfo.name` it sends, and name-length
   * checks assume a one-character name.
   */
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
  endpointId?: string;
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
 * A server Doctor cannot read is contributed as `{ url, error }`.
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
        async contribute() {
          const mcpServers = await Promise.all(
            targets.map((target) => readServer(target, options)),
          );
          return { mcpServers };
        },
      });
    },
  };
}

async function readServer(
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
    return {
      ...(serverName ? { name: serverName } : {}),
      url: label,
      endpointId,
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

/**
 * One evidence gap per MCP server that any Runtime Evidence contributor could not read, so the
 * report is `incomplete` rather than clean.
 */
export function unreadMcpServerGaps(
  project: ProjectInfo,
): NonNullable<ProjectInfo["evidenceGaps"]> {
  return readMcpServers(project.runtimeEvidence)
    .filter(
      (server): server is McpServerErrorEvidence =>
        typeof (server as Partial<McpServerErrorEvidence>).error === "string",
    )
    .map(({ url, endpointId, error, status }) => ({
      source: MCP_EVIDENCE,
      message: `Doctor could not read the tools of the MCP server at ${mcpEndpointLabel(url)}, so its tools were not checked: ${error}${
        status === 401 || status === 403
          ? ' On the CLI, pass it with --mcp-header "Authorization: Bearer <token>".'
          : ""
      }`,
      files: [],
      instanceKey: endpointId ?? mcpEndpointId(url),
    }));
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
  const names = servers
    .map((server) => (server.url ? mcpEndpointLabel(server.url) : (server.name ?? "an MCP server")))
    .join(", ");
  return {
    source: MCP_EVIDENCE,
    message: `Doctor read the tools of ${names} as Runtime Evidence but did not check them: the vite-doctor/mcp Rule Pack is not selected, because no MCP package is in the project or the selected Presets leave it out. Add "mcp/recommended" to extends to check them.`,
    files: [],
  };
}
