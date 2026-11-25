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
  for (const server of servers.splice(0)) server.close();
});

async function serve(handler: Handler): Promise<string> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => handler(JSON.parse(body), request, response));
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
      method: message.method,
      session: request.headers["mcp-session-id"] as string | undefined,
      version: request.headers["mcp-protocol-version"] as string | undefined,
      cursor: message.params?.cursor,
    });
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

test("rejects a tools/list result with a tool without a name", async () => {
  const url = await serve((message, _request, response) => {
    if (message.method === "notifications/initialized") {
      response.writeHead(202);
      return response.end();
    }
    json(response, message.id, message.method === "initialize" ? initialize : { tools: [{}] });
  });
  await expect(fetchMcpToolList(url)).rejects.toThrow("a tool without a `name`");
});

test("reads an SSE response the server keeps open", async () => {
  const url = await serve((message, _request, response) => {
    if (message.method === "notifications/initialized") {
      response.writeHead(202);
      return response.end();
    }
    const result = message.method === "initialize" ? initialize : { tools: [{ name: "search" }] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
  });
  const list = await fetchMcpToolList(url, { timeout: 2_000 });
  expect(list.tools).toEqual([{ name: "search" }]);
});

test("does not follow a redirect", async () => {
  let redirected = false;
  const target = await serve((_message, _request, response) => {
    redirected = true;
    response.writeHead(500).end();
  });
  const url = await serve((_message, _request, response) => {
    response.writeHead(307, { location: target }).end();
  });
  await expect(
    fetchMcpToolList(url, { headers: { authorization: "Bearer token" } }),
  ).rejects.toThrow(`pass the final URL, ${target}`);
  expect(redirected).toBe(false);
});

test("reports a JSON-RPC error", async () => {
  const url = await serve((message, _request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Nope" } }),
    );
  });
  await expect(fetchMcpToolList(url)).rejects.toThrow(
    "initialize returned JSON-RPC error -32601: Nope",
  );
});
