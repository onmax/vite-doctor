import {
  fetchMcpToolList,
  isMcpHeaderName,
  McpFetchError,
  mcpEndpointLabel,
  parseMcpEndpoint,
  type McpInitializeResult,
  type McpTool,
} from "@loadsheet/mcp";
import type { EvidenceSource, ProjectInfo } from "../core/primitives.js";
import { sha256 } from "../core/internal/utils.js";
import { viteDoctorVersion } from "../version.js";
import { mcpEndpointId } from "./endpoint.js";

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
    return Array.isArray(servers)
      ? servers.filter(isMcpServerEvidence).map(withoutFailedTools)
      : [];
  });
}

/**
 * The MCP servers in a Doctor Run's Runtime Evidence by endpoint origin, or by name when an
 * Extension reported no URL. Reports never show more of the endpoint than this.
 */
export function mcpServerLabels(runtimeEvidence: Record<string, unknown> | undefined): string[] {
  return [
    ...new Set(
      readMcpServers(runtimeEvidence).map((server) =>
        server.url ? mcpEndpointLabel(server.url) : (server.name ?? "an MCP server"),
      ),
    ),
  ];
}

// A read that failed has no tools, whatever else an Extension put beside its error.
function withoutFailedTools(server: McpServerEvidence): McpServerEvidence {
  if (typeof (server as { error?: unknown }).error !== "string" || !("tools" in server))
    return server;
  const { tools: _tools, ...failed } = server as McpServerErrorEvidence & { tools: unknown };
  return failed;
}

// Any Doctor Extension can contribute this evidence, so only well-formed entries are read.
function isMcpServerEvidence(value: unknown): value is McpServerEvidence {
  if (!value || typeof value !== "object") return false;
  const server = value as Partial<McpServerToolsEvidence & McpServerErrorEvidence>;
  if (typeof server.error === "string") return typeof server.url === "string";
  return Array.isArray(server.tools) && server.tools.every(isMcpTool);
}

function isMcpTool(tool: unknown): tool is McpTool {
  return !!tool && typeof tool === "object" && typeof (tool as McpTool).name === "string";
}

const PUBLIC_MCP_PATHS = new Set(["/", "/mcp", "/sse", "/v1/sse", "/github-copilot/mcp"]);

/**
 * Reads `tools/list` from each MCP server the run is given, with `--mcp-url` and `--mcp-header`
 * on the CLI. A server Doctor cannot read is contributed as `{ url, error }` and an evidence gap.
 */
export const mcpEvidenceSource: EvidenceSource<McpServerTarget[]> = {
  name: MCP_EVIDENCE,
  label: "MCP server",
  beforeRuntimeEvidence: true,
  options: {
    url: {
      help: "Read tools/list from this MCP server as Runtime Evidence. Repeatable.",
      value: "url",
      repeatable: true,
      // Credentials, query strings, and custom paths can all carry secrets.
      secret(value, redacted) {
        const url = parseMcpEndpoint(value);
        if (!url) return redacted;
        const credentials = url.username || url.password ? `${redacted}@` : "";
        const path = PUBLIC_MCP_PATHS.has(url.pathname) ? url.pathname : `/${redacted}`;
        return `${url.protocol}//${credentials}${url.host}${path}${url.search ? `?${redacted}` : ""}`;
      },
    },
    header: {
      help: 'Request header for every --mcp-url, as "Name: value". Repeatable.',
      value: "header",
      repeatable: true,
      requires: "url",
      secret: (value, redacted) => `${value.slice(0, value.indexOf(":"))}: ${redacted}`,
    },
  },
  fromOptions({ url = [], header = [] }) {
    const headers = new Map<string, string>();
    for (const entry of header) {
      const colon = entry.indexOf(":");
      const name = colon === -1 ? "" : entry.slice(0, colon).trim();
      if (!isMcpHeaderName(name))
        throw new Error(
          '--mcp-header must look like "Name: value", such as "Authorization: Bearer <token>".',
        );
      headers.set(name, entry.slice(colon + 1).trim());
    }
    return url.map((target) => ({
      url: target,
      ...(headers.size ? { headers: Object.fromEntries(headers) } : {}),
    }));
  },
  toOptions: (targets) => ({
    url: targets.map((target) => target.url),
    header: Object.entries(targets[0]?.headers ?? {})
      .filter(([name]) => isMcpHeaderName(name))
      .map(([name, value]) => `${name}: ${value}`),
  }),
  validate(targets) {
    for (const target of targets) assertAbsoluteMcpUrl(target.url);
  },
  async collect(targets, { fetch }) {
    const mcpServers = await Promise.all(targets.map((target) => readServer(target, { fetch })));
    const gaps = new Map<string, { message: string; instanceKey: string }>();
    for (const server of mcpServers) {
      if (!("error" in server)) continue;
      const instanceKey = unreadGapKey(server);
      if (gaps.has(instanceKey)) continue;
      gaps.set(instanceKey, {
        message: `Doctor could not read the tools of the MCP server at ${server.url}, so its tools were not checked: ${server.error}${authHint(server.status)}`,
        instanceKey,
      });
    }
    return {
      evidence: { mcpServers },
      targets: mcpServerLabels({ [MCP_EVIDENCE]: { mcpServers } }),
      gaps: [...gaps.values()],
    };
  },
};

async function readServer(
  { url, headers, serverName }: McpServerTarget,
  options: { fetch?: typeof globalThis.fetch; timeout?: number },
): Promise<McpServerEvidence> {
  const label = mcpEndpointLabel(url);
  const endpointId = mcpEndpointId(url);
  try {
    const list = await fetchMcpToolList(url, {
      headers,
      maxPages: 50,
      clientInfo: { name: "vite-doctor", version: viteDoctorVersion },
      ...options,
    });
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

export function mcpEvidenceUsed(
  checked: readonly McpServerToolsEvidence[],
  fileOverridesOnly = false,
): NonNullable<ProjectInfo["evidenceUsed"]> {
  return checked.map((server) => {
    const label = server.url ? mcpEndpointLabel(server.url) : (server.name ?? "an MCP server");
    const count = `${server.tools.length} ${server.tools.length === 1 ? "tool" : "tools"}`;
    return {
      source: MCP_EVIDENCE,
      message: `tools/list of the MCP server at ${label}, ${count}${fileOverridesOnly ? " (file overrides only)" : ""}`,
    };
  });
}

/**
 * One evidence gap per MCP server that any Runtime Evidence contributor could not read, so the
 * report is `incomplete` rather than clean.
 */
export function unreadMcpServerGaps(
  project: ProjectInfo,
): NonNullable<ProjectInfo["evidenceGaps"]> {
  const gaps = new Map<string, NonNullable<ProjectInfo["evidenceGaps"]>[number]>();
  const read = new Set(
    (project.evidenceGaps ?? []).flatMap((gap) =>
      gap.source === MCP_EVIDENCE && gap.instanceKey ? [gap.instanceKey] : [],
    ),
  );
  for (const [contributor, entry] of Object.entries(project.runtimeEvidence ?? {})) {
    for (const server of readMcpServers({ [contributor]: entry })) {
      if (typeof (server as Partial<McpServerErrorEvidence>).error !== "string") continue;
      const { url, status } = server as McpServerErrorEvidence;
      const instanceKey = unreadGapKey(server as McpServerErrorEvidence);
      if (read.has(instanceKey) || gaps.has(instanceKey)) continue;
      const code = Number.isInteger(status) ? status : undefined;
      // A contributor's error text can carry the URL and its credentials, so only the status is shown.
      gaps.set(instanceKey, {
        source: MCP_EVIDENCE,
        message: `The ${JSON.stringify(contributor)} Runtime Evidence contributor could not read the tools of the MCP server at ${mcpEndpointLabel(url)}${code ? ` (HTTP ${code})` : ""}, so its tools were not checked.${authHint(code)}`,
        files: [],
        instanceKey,
      });
    }
  }
  return [...gaps.values()];
}

// An Extension's endpoint ID or URL can carry credentials, so a gap keeps only its hash.
function unreadGapKey({ endpointId, url }: McpServerErrorEvidence): string {
  const id = typeof endpointId === "string" ? endpointId : url;
  return sha256(mcpEndpointId(id) ?? id);
}

function authHint(status: number | undefined): string {
  return status === 401 || status === 403
    ? ' On the CLI, pass it with --mcp-header "Authorization: Bearer <token>".'
    : "";
}

/**
 * MCP Runtime Evidence without project-wide coverage because an explicit extends list leaves
 * the MCP Rule Pack out. File overrides can check source-located tools without closing the gap.
 */
export function uncheckedMcpEvidenceGap(
  project: ProjectInfo,
): NonNullable<ProjectInfo["evidenceGaps"]>[number] | undefined {
  const servers = readMcpServers(project.runtimeEvidence).filter(
    (server): server is McpServerToolsEvidence => "tools" in server,
  );
  if (!servers.length) return undefined;
  const names = servers
    .map((server) => (server.url ? mcpEndpointLabel(server.url) : (server.name ?? "an MCP server")))
    .join(", ");
  return {
    source: MCP_EVIDENCE,
    message: `Doctor read the tools of ${names} as Runtime Evidence, but no MCP client Rule checked them project-wide: the extends list leaves out the vite-doctor/mcp Rule Pack. Add "auto", or "mcp/recommended" ("mcp/strict" for the Strict Preset), to the selectors you already have; a CLI --extends replaces the configured list, so repeat them there.`,
    files: [],
  };
}
