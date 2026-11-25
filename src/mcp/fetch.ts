import type { McpInitializeResult, McpTool, McpToolList } from "./types.js";

const PROTOCOL_VERSION = "2025-11-25";
// A server that never stops paginating must not hang a Doctor Run.
const MAX_PAGES = 50;

export interface FetchMcpToolListOptions {
  /** Extra request headers, such as `authorization`. */
  headers?: Record<string, string>;
  /** Aborts every request after this many milliseconds. Defaults to 10 seconds. */
  timeout?: number;
  fetch?: typeof globalThis.fetch;
}

export class McpFetchError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "McpFetchError";
    this.status = status;
  }
}

/**
 * Reads a Streamable HTTP MCP server's `initialize` result and every page of `tools/list`,
 * the same requests a client sends when it connects.
 */
export async function fetchMcpToolList(
  url: string | URL,
  options: FetchMcpToolListOptions = {},
): Promise<McpToolList> {
  const request = createRequester(new URL(url), options);
  const initialize = (await request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "vite-doctor", version: "0.0.0" },
  })) as McpInitializeResult;
  await request("notifications/initialized", undefined, true);
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = (await request("tools/list", cursor ? { cursor } : {})) as {
      tools?: unknown;
      nextCursor?: unknown;
    };
    if (!Array.isArray(result?.tools))
      throw new McpFetchError("The server's tools/list result has no `tools` array.");
    if (!result.tools.every((tool) => typeof tool?.name === "string"))
      throw new McpFetchError("The server's tools/list result has a tool without a `name`.");
    tools.push(...(result.tools as McpTool[]));
    cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : "";
    if (!cursor) return { initialize, tools };
  }
  throw new McpFetchError(`The server's tools/list kept paginating past ${MAX_PAGES} pages.`);
}

function createRequester(url: URL, options: FetchMcpToolListOptions) {
  const fetch = options.fetch ?? globalThis.fetch;
  const timeout = options.timeout ?? 10_000;
  let sessionId: string | undefined;
  let protocolVersion: string | undefined;
  let id = 0;
  return async (method: string, params: unknown, notification = false): Promise<unknown> => {
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...options.headers,
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;
    const body = notification
      ? { jsonrpc: "2.0", method }
      : { jsonrpc: "2.0", id: ++id, method, ...(params === undefined ? {} : { params }) };
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
        // A redirect could carry a token or the session ID to another origin.
        redirect: "manual",
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new McpFetchError(`${method} to ${url.href} failed: ${reason}`);
    }
    if (!response.ok && !(notification && response.status === 202)) {
      const location = response.headers.get("location");
      const hint =
        response.status === 401 || response.status === 403
          ? " The endpoint needs authorization; pass a token in `headers`."
          : location
            ? ` Doctor does not follow redirects; pass the final URL, ${location}.`
            : "";
      throw new McpFetchError(
        `${method} to ${url.href} answered HTTP ${response.status}.${hint}`,
        response.status,
      );
    }
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    if (notification) {
      await response.body?.cancel();
      return undefined;
    }
    const message = await readMessage(response, id);
    if (message.error)
      throw new McpFetchError(
        `${method} returned JSON-RPC error ${message.error.code}: ${message.error.message}`,
      );
    if (method === "initialize") {
      const version = (message.result as { protocolVersion?: unknown })?.protocolVersion;
      if (typeof version === "string") protocolVersion = version;
    }
    return message.result;
  };
}

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

async function readMessage(response: Response, id: number): Promise<JsonRpcResponse> {
  const type = response.headers.get("content-type") ?? "";
  const message =
    type.includes("text/event-stream") && response.body
      ? await readEvents(response.body, id)
      : findResponse([await response.text()], id);
  if (message) return message;
  throw new McpFetchError(`The server sent no JSON-RPC response for request ${id}.`);
}

// Reads events as they arrive: a server that keeps the stream open after the response is valid.
async function readEvents(
  body: ReadableStream<Uint8Array>,
  id: number,
): Promise<JsonRpcResponse | undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = done ? "" : blocks.pop()!;
      const message = findResponse(blocks.flatMap(eventData), id);
      if (message || done) return message;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function findResponse(candidates: string[], id: number): JsonRpcResponse | undefined {
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      if (message && typeof message === "object" && (message as JsonRpcResponse).id === id)
        return message as JsonRpcResponse;
    }
  }
  return undefined;
}

function eventData(stream: string): string[] {
  const events: string[] = [];
  for (const block of stream.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    if (data.length) events.push(data.join("\n"));
  }
  return events;
}
