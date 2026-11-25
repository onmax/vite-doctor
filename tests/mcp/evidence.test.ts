import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { main } from "../../src/cli.ts";
import { createReport, reportStatus } from "../../src/core/index.ts";
import { runViteDoctor } from "../../src/doctor.ts";
import { readMcpServers } from "../../src/mcp/evidence.ts";
import { startMcpStub, stubTools, type StubRequest } from "./mcp-stub.ts";

const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function project(dependencies: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "doctor-mcp-evidence-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", dependencies }));
  writeFileSync(join(root, "index.ts"), "export const ok = 1;\n");
  return root;
}

async function stub(options: Parameters<typeof startMcpStub>[0] = {}) {
  const server = await startMcpStub(options);
  cleanups.push(server.close);
  return server;
}

const mcpServerPackage = { "@modelcontextprotocol/sdk": "^1.32.0" };

test("a Doctor Run reads an MCP server's tools/list as Runtime Evidence", async () => {
  const server = await stub();
  const root = project(mcpServerPackage);
  const result = await runViteDoctor({ root, cache: false, mcp: [{ url: server.url }] });

  const evidence = result.project.runtimeEvidence?.mcp as {
    mcpServers: Array<{ name?: string; url: string; tools: unknown[] }>;
  };
  expect(evidence.mcpServers[0]).toMatchObject({
    name: "stub",
    url: new URL(server.url).origin,
    tools: stubTools,
  });
  expect(evidence.mcpServers[0]).not.toHaveProperty("clientAlias");
  expect(readMcpServers(result.project.runtimeEvidence)).toEqual(evidence.mcpServers);
  expect(result.project.evidenceGaps ?? []).toEqual([]);
});

test("an MCP server that answers 401 leaves an evidence gap and an incomplete report", async () => {
  const server = await stub({ token: "secret" });
  const root = project(mcpServerPackage);
  const result = await runViteDoctor({ root, cache: false, mcp: [{ url: server.url }] });

  expect(reportStatus(result)).toBe("incomplete");
  const gaps = result.project.evidenceGaps ?? [];
  expect(gaps).toHaveLength(1);
  expect(gaps[0]!.source).toBe("mcp");
  expect(gaps[0]!.message).toContain(new URL(server.url).origin);
  expect(gaps[0]!.message).toContain("HTTP 401");
  expect(gaps[0]!.message).toContain("--mcp-header");
  expect(readMcpServers(result.project.runtimeEvidence)).toEqual([
    expect.objectContaining({ url: new URL(server.url).origin, status: 401 }),
  ]);
});

test("headers reach the MCP server and never reach the report", async () => {
  const server = await stub({ token: "secret" });
  const root = project(mcpServerPackage);
  const result = await runViteDoctor({
    root,
    cache: false,
    mcp: [{ url: server.url, headers: { authorization: "Bearer secret" }, serverName: "drops" }],
  });

  expect(readMcpServers(result.project.runtimeEvidence)).toEqual([
    expect.objectContaining({ name: "drops", tools: stubTools }),
  ]);
  expect(createReport(result, "json")).not.toContain("secret");
  expect(JSON.stringify(result.project.runtimeEvidence)).not.toContain("secret");
});

test("a run without MCP URLs contributes no MCP evidence and records no gap", async () => {
  const result = await runViteDoctor({ root: project(mcpServerPackage), cache: false });

  expect(result.project.runtimeEvidence?.mcp).toBeUndefined();
  expect(result.project.evidenceGaps ?? []).toEqual([]);
});

test("malformed tool lists leave a gap without exposing the request URL", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const message = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    return Response.json({
      id: message.id,
      result: message.method === "initialize" ? {} : { tools: [{ description: "Search" }] },
    });
  });
  const root = project(mcpServerPackage);
  const url = "https://user:password@example.test/path-secret?token=query-secret#fragment-secret";
  const result = await runViteDoctor({ root, cache: false, mcp: [{ url }] });
  expect(reportStatus(result)).toBe("incomplete");
  expect(result.project.evidenceGaps?.[0]?.message).toContain("tools[0]");
  const report = createReport(result, "agent", {
    runOptions: { root, mcp: [{ url, headers: { "invalid fake-secret": "value" } }] },
  });
  expect(report).toContain("<mcp-url>");
  expect(report).not.toMatch(/path-secret|query-secret|fragment-secret|password|fake-secret/);
  expect(JSON.stringify(result.project.runtimeEvidence)).not.toMatch(
    /path-secret|query-secret|fragment-secret|password/,
  );
});

test("MCP evidence the MCP Rule Pack does not check leaves an evidence gap", async () => {
  const server = await stub();
  const result = await runViteDoctor({ root: project(), cache: false, mcp: [{ url: server.url }] });

  expect(reportStatus(result)).toBe("incomplete");
  expect(result.project.evidenceGaps).toEqual([
    expect.objectContaining({
      source: "mcp",
      message: expect.stringContaining(
        `${new URL(server.url).origin} as Runtime Evidence but did not check them`,
      ),
    }),
  ]);

  const selected = await runViteDoctor({
    root: project(),
    cache: false,
    extends: ["auto", "mcp/recommended"],
    mcp: [{ url: server.url }],
  });
  expect(selected.project.evidenceGaps ?? []).toEqual([]);
});

test("readMcpServers collects mcpServers from every contributor and skips malformed entries", () => {
  expect(
    readMcpServers({
      mcp: { mcpServers: [{ url: "http://a/mcp", tools: [{ name: "a" }] }] },
      vitehub: {
        mcpServers: [{ name: "hub", tools: [{ name: "b" }] }, { tools: [{}] }, { error: "x" }],
      },
      vite: { other: true },
    }),
  ).toEqual([
    { url: "http://a/mcp", tools: [{ name: "a" }] },
    { name: "hub", tools: [{ name: "b" }] },
  ]);
});

async function cli(root: string, args: string[]) {
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  const code = await main(args, root);
  vi.restoreAllMocks();
  return { code, output };
}

test("--mcp-url and --mcp-header repeat, and every header goes to every URL", async () => {
  const requests: StubRequest[] = [];
  const first = await stub({ token: "secret", requests });
  const second = await stub({ token: "secret", requests });
  const root = project(mcpServerPackage);
  const { code, output } = await cli(root, [
    ".",
    "--no-cache",
    "--format",
    "agent",
    "--mcp-url",
    `${first.url}/path-secret?token=query-secret`,
    "--mcp-url",
    second.url,
    "--mcp-header",
    "Authorization: Bearer secret",
    "--mcp-header",
    "X-Team:  drops ",
  ]);

  expect(code).toBe(0);
  expect(requests).toHaveLength(8);
  for (const url of [`${first.url}/path-secret?token=query-secret`, second.url]) {
    const { pathname, search } = new URL(url);
    expect(
      requests
        .filter((request) => request.path === pathname + search)
        .map((request) => request.method),
    ).toEqual(["initialize", "notifications/initialized", "tools/list", "DELETE"]);
  }
  for (const request of requests) {
    expect(request.headers.authorization).toBe("Bearer secret");
    expect(request.headers["x-team"]).toBe("drops");
  }
  expect(output).not.toContain("secret");
  const report = JSON.parse(output) as { commandArgs: { rerun: string[] } };
  expect(report.commandArgs.rerun).toEqual(expect.arrayContaining(["--mcp-url", "<mcp-url>"]));
  expect(report.commandArgs.rerun.filter((arg) => arg === "<mcp-url>")).toHaveLength(2);
  expect(report.commandArgs.rerun).toContain("Authorization: <value>");
});

test.each([
  [["--mcp-header", "Authorization: Bearer x"], "--mcp-header requires --mcp-url"],
  [
    ["--mcp-url", "http://127.0.0.1:1/mcp", "--mcp-header", "no colon"],
    'must look like "Name: value"',
  ],
  [["--mcp-url", "/mcp"], "is not an absolute http(s) URL"],
  [
    ["--mcp-url", "http://127.0.0.1:1/mcp", "--mcp-header", "Bearer fake-secret: value"],
    'must look like "Name: value"',
  ],
])("the CLI rejects %j as an invocation error", async (args, message) => {
  const { code, output } = await cli(project(), [".", "--no-cache", "--format", "json", ...args]);
  expect(code).toBe(2);
  expect(output).not.toContain("no colon");
  expect(output).not.toContain("fake-secret");
  expect(JSON.parse(output).error).toMatchObject({
    kind: "invocation",
    message: expect.stringContaining(message),
  });
});
