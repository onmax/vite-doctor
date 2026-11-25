import { parseMcpEndpoint } from "./endpoint.js";
import { validateTools } from "./input.js";
import type { McpInitializeResult, McpTool, McpToolList } from "./types.js";

const PROTOCOL_VERSION = "2025-11-25";
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
 * the same requests a client sends when it connects. Redirects are not followed.
 */
export async function fetchMcpToolList(
  url: string | URL,
  options: FetchMcpToolListOptions = {},
): Promise<McpToolList> {
  const endpoint = parseMcpEndpoint(url);
  if (!endpoint) throw new McpFetchError("Expected an absolute HTTP(S) MCP endpoint.");
  const { request, close } = createRequester(endpoint, options);
  try {
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
      try {
        tools.push(...validateTools(result.tools));
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        throw new McpFetchError(error.message);
      }
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
      if (!cursor) return { initialize, tools };
    }
    throw new McpFetchError(`The server's tools/list kept paginating past ${MAX_PAGES} pages.`);
  } finally {
    await close();
  }
}

function createRequester(url: URL, options: FetchMcpToolListOptions) {
  const fetch = options.fetch ?? globalThis.fetch;
  const timeout = options.timeout ?? 10_000;
  let sessionId: string | undefined;
  let protocolVersion: string | undefined;
  let id = 0;
  function headers() {
    const result = new Headers({
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...options.headers,
    });
    if (sessionId) result.set("mcp-session-id", sessionId);
    if (protocolVersion) result.set("mcp-protocol-version", protocolVersion);
    return result;
  }
  async function send(method: "POST" | "DELETE", body?: unknown) {
    return fetch(url, {
      method,
      headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(timeout),
    });
  }
  async function close() {
    if (!sessionId) return;
    try {
      cancelBody(await send("DELETE"));
    } catch {
      return;
    }
  }
  async function request(method: string, params: unknown, notification = false): Promise<unknown> {
    const body = notification
      ? { jsonrpc: "2.0", method }
      : { jsonrpc: "2.0", id: ++id, method, ...(params === undefined ? {} : { params }) };
    try {
      const response = await send("POST", body);
      if (!response.ok) {
        cancelBody(response);
        const hint =
          response.status >= 300 && response.status < 400
            ? " MCP redirects are not followed; configure the final endpoint URL."
            : response.status === 401 || response.status === 403
              ? " The endpoint needs authorization; pass a token in `headers`."
              : "";
        throw new McpFetchError(
          `${method} answered HTTP ${response.status}.${hint}`,
          response.status,
        );
      }
      if (method === "initialize") sessionId = response.headers.get("mcp-session-id") ?? undefined;
      if (notification) {
        cancelBody(response);
        return undefined;
      }
      const message = await readMessage(response, id);
      if (message.error) {
        const code = typeof message.error.code === "number" ? ` ${message.error.code}` : "";
        throw new McpFetchError(`${method} returned JSON-RPC error${code}.`);
      }
      if (method === "initialize") {
        const version = (message.result as McpInitializeResult | undefined)?.protocolVersion;
        if (typeof version === "string") protocolVersion = version;
      }
      return message.result;
    } catch (error) {
      if (error instanceof McpFetchError) throw error;
      throw new McpFetchError(`${method} failed to send the request or read the response.`);
    }
  }
  return { request, close };
}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown };
}

async function readMessage(response: Response, id: number): Promise<JsonRpcResponse> {
  const type = response.headers.get("content-type") ?? "";
  const message = type.toLowerCase().includes("text/event-stream")
    ? await readEventStream(response.body, id)
    : matchingMessage(await response.text(), id);
  if (message) return message;
  throw new McpFetchError(`The server sent no JSON-RPC response for request ${id}.`);
}

function matchingMessage(text: string, id: number): JsonRpcResponse | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
    if (message && typeof message === "object" && (message as JsonRpcResponse).id === id)
      return message as JsonRpcResponse;
  }
}

async function readEventStream(body: Response["body"], id: number) {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let line = "";
  let skipLF = false;
  let data: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      for (const character of decoder.decode(value, { stream: true })) {
        const ignore = skipLF && character === "\n";
        skipLF = character === "\r";
        if (ignore) continue;
        if (character !== "\r" && character !== "\n") {
          line += character;
          continue;
        }
        if (!line && data.length) {
          const message = matchingMessage(data.join("\n"), id);
          if (message) return message;
          data = [];
        } else if (line === "data" || line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
        line = "";
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
