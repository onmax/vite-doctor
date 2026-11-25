import { createServer, type IncomingHttpHeaders, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpTool } from "../../src/mcp/types.ts";

export const stubTools: McpTool[] = [
  {
    name: "list_drops",
    title: "List drops",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
];

export interface StubRequest {
  path: string;
  method: string;
  headers: IncomingHttpHeaders;
}

/**
 * A Streamable HTTP MCP server answering with JSON: `initialize`, `notifications/initialized`
 * (202), and `tools/list`. A request without `authorization: Bearer <token>` gets 401 when
 * `token` is set.
 */
export function mcpStubHandler(
  options: { token?: string; requests?: StubRequest[] } = {},
): RequestListener {
  return (request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const message = JSON.parse(body || "{}") as { id?: number; method?: string };
      options.requests?.push({
        path: request.url ?? "",
        method: message.method ?? "",
        headers: request.headers,
      });
      if (options.token && request.headers.authorization !== `Bearer ${options.token}`) {
        response.writeHead(401).end();
        return;
      }
      if (message.method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "stub", version: "1.0.0" },
            }
          : { tools: stubTools };
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  };
}

export async function startMcpStub(options: { token?: string; requests?: StubRequest[] } = {}) {
  const server = createServer(mcpStubHandler(options));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
