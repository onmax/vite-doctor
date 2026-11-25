import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vite-plus/test";
import { fetchMcpToolList, McpFetchError } from "../../src/mcp/index.ts";

type Handler = (
  message: { method: string; id?: number; params?: any },
  request: IncomingMessage,
  response: ServerResponse,
) => void;

const servers: ReturnType<typeof createServer>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
    server.closeAllConnections();
  }
});

async function serve(handler: Handler): Promise<string> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => handler(JSON.parse(body || "{}"), request, response));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

function json(response: ServerResponse, id: number | undefined, result: unknown, headers = {}) {
  response.writeHead(200, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function sse(response: ServerResponse, id: number | undefined, result: unknown) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(
    `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n\n`,
  );
  response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`);
}

const initialize = {
  protocolVersion: "2025-06-18",
  serverInfo: { name: "docs", version: "1.0.0" },
  instructions: "Search the docs.",
};

test("reads initialize and every tools/list page over JSON and SSE with the session id", async () => {
  const seen: { method: string; session?: string; version?: string; cursor?: string }[] = [];
  const url = await serve((message, request, response) => {
    seen.push({
      method: request.method === "DELETE" ? "DELETE" : message.method,
      session: request.headers["mcp-session-id"] as string | undefined,
      version: request.headers["mcp-protocol-version"] as string | undefined,
      cursor: message.params?.cursor,
    });
    if (request.method === "DELETE") return void response.writeHead(204).end();
    if (message.method === "initialize")
      return json(response, message.id, initialize, { "mcp-session-id": "session-1" });
    if (message.method === "notifications/initialized") {
      response.writeHead(202);
      return response.end();
    }
    if (!message.params?.cursor)
      return json(response, message.id, { tools: [{ name: "search" }], nextCursor: "page-2" });
    return sse(response, message.id, { tools: [{ name: "fetch" }] });
  });

  const list = await fetchMcpToolList(url);

  expect(list).toEqual({ initialize, tools: [{ name: "search" }, { name: "fetch" }] });
  expect(seen).toEqual([
    { method: "initialize", session: undefined, version: undefined, cursor: undefined },
    {
      method: "notifications/initialized",
      session: "session-1",
      version: "2025-06-18",
      cursor: undefined,
    },
    { method: "tools/list", session: "session-1", version: "2025-06-18", cursor: undefined },
    { method: "tools/list", session: "session-1", version: "2025-06-18", cursor: "page-2" },
    { method: "DELETE", session: "session-1", version: "2025-06-18", cursor: undefined },
  ]);
});

test("reports a 401 with a hint and the status", async () => {
  const url = await serve((_message, _request, response) => {
    response.writeHead(401);
    response.end();
  });
  const error = await fetchMcpToolList(url, { headers: { authorization: "Bearer x" } }).catch(
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(McpFetchError);
  expect(error).toMatchObject({ status: 401 });
  expect((error as Error).message).toContain("needs authorization");
});

test("returns the matching SSE result without waiting for the connection to close", async () => {
  let canceled = false;
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const message = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (message.method === "initialize")
      return Response.json({ id: message.id, result: initialize });
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of [
            'data: {"id":99,"result":{}}\r\n\r\n',
            `data: {"jsonrpc":"2.0",\r`,
            `\ndata: "id":${message.id},"result":{"tools":[{"name":"café"}]}}\r\n\r\n`,
          ])
            controller.enqueue(encoder.encode(chunk));
        },
        cancel() {
          canceled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  await expect(fetchMcpToolList("https://example.test/mcp", { fetch })).resolves.toMatchObject({
    tools: [{ name: "café" }],
  });
  expect(canceled).toBe(true);
}, 1_000);

test("reports a redirect without enabling automatic forwarding", async () => {
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    expect(init?.redirect).toBe("manual");
    return Response.redirect("https://other.example.test/mcp", 307);
  };
  await expect(fetchMcpToolList("https://example.test/mcp", { fetch })).rejects.toThrow(
    "redirects are not followed",
  );
});

test("rejects redirects without forwarding MCP headers", async () => {
  let forwarded = false;
  const other = await serve((_message, _request, response) => {
    forwarded = true;
    response.writeHead(403).end();
  });
  const url = await serve((_message, _request, response) => {
    response.writeHead(307, { location: other }).end();
  });
  await expect(fetchMcpToolList(url, { headers: { "X-API-Key": "test-token" } })).rejects.toThrow(
    "redirect",
  );
  expect(forwarded).toBe(false);
});

test("rejects malformed tools and terminates the assigned session on failure", async () => {
  const terminated: Array<[unknown, unknown]> = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    if (init?.method === "DELETE") {
      const headers = new Headers(init.headers);
      terminated.push([headers.get("mcp-session-id"), headers.get("mcp-protocol-version")]);
      return new Response(null, { status: 405 });
    }
    const message = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (message.method === "initialize")
      return Response.json(
        { id: message.id, result: initialize },
        { headers: { "mcp-session-id": "session-1" } },
      );
    return Response.json({ id: message.id, result: { tools: [{ description: "Search" }] } });
  };
  await expect(fetchMcpToolList("https://example.test/mcp", { fetch })).rejects.toThrow("tools[0]");
  expect(terminated).toEqual([["session-1", "2025-06-18"]]);
});

test("sends the given headers", async () => {
  let authorization: string | undefined;
  const url = await serve((message, request, response) => {
    authorization ??= request.headers.authorization;
    if (message.method === "notifications/initialized") {
      response.writeHead(202);
      return response.end();
    }
    json(response, message.id, message.method === "initialize" ? initialize : { tools: [] });
  });
  await fetchMcpToolList(url, { headers: { authorization: "Bearer token" } });
  expect(authorization).toBe("Bearer token");
});

test("reports a JSON-RPC error", async () => {
  const url = await serve((message, _request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Nope" } }),
    );
  });
  await expect(fetchMcpToolList(url)).rejects.toThrow("initialize returned JSON-RPC error -32601.");
});
