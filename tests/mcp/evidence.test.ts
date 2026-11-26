import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { main } from "../../src/cli.ts";
import { createReport, reportStatus, runDoctor } from "../../src/core/index.ts";
import { runViteDoctor } from "../../src/doctor.ts";
import { createRule, defineRulePack } from "../../src/extension.ts";
import { readMcpServers } from "../../src/mcp/evidence.ts";
import { viteDoctorVersion } from "../../src/version.ts";
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
  const result = await runViteDoctor({
    root,
    cache: false,
    mcp: [{ url: server.url }, { url: server.url, serverName: "again" }],
  });

  expect(reportStatus(result)).toBe("incomplete");
  const gaps = result.project.evidenceGaps ?? [];
  expect(gaps).toHaveLength(1);
  expect(gaps[0]!.source).toBe("mcp");
  expect(gaps[0]!.message).toContain(new URL(server.url).origin);
  expect(gaps[0]!.message).toContain("HTTP 401");
  expect(gaps[0]!.message).toContain("--mcp-header");
  expect(readMcpServers(result.project.runtimeEvidence)).toEqual([
    expect.objectContaining({ url: new URL(server.url).origin, status: 401 }),
    expect.objectContaining({ name: "again", status: 401 }),
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
  expect(JSON.parse(report).commandArgs.rerun).toEqual(
    expect.arrayContaining([
      "--mcp-url",
      "https://<redacted>@example.test/path-secret?token=<redacted>",
    ]),
  );
  expect(report).not.toMatch(/query-secret|fragment-secret|password|fake-secret/);
  expect(JSON.stringify(result.project.runtimeEvidence)).not.toMatch(
    /path-secret|query-secret|fragment-secret|password/,
  );
});

test("MCP evidence activates the MCP Rule Pack in a project without an MCP package", async () => {
  const server = await stub();
  const origin = new URL(server.url).origin;
  const result = await runViteDoctor({ root: project(), cache: false, mcp: [{ url: server.url }] });

  expect(result.project.evidenceGaps ?? []).toEqual([]);
  expect(result.rulePacks).toContainEqual(
    expect.objectContaining({ name: "vite-doctor/mcp", selected: true, activatedBy: ["."] }),
  );
  expect(result.project.evidenceUsed).toEqual([
    { source: "mcp", message: `tools/list of the MCP server at ${origin}, 1 tool` },
  ]);
  expect(createReport(result, "text")).toContain(
    `Evidence used: tools/list of the MCP server at ${origin}`,
  );

  const strict = await runViteDoctor({
    root: project(),
    cache: false,
    extends: ["strict"],
    mcp: [{ url: server.url }],
  });
  expect(strict.project.evidenceGaps ?? []).toEqual([]);
});

test("MCP evidence activates the MCP Rule Pack for every workspace package", async () => {
  const server = await stub();
  const root = project();
  writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  for (const name of ["a", "b"]) {
    mkdirSync(join(root, "packages", name), { recursive: true });
    writeFileSync(join(root, "packages", name, "package.json"), JSON.stringify({ name }));
    writeFileSync(join(root, "packages", name, "index.ts"), "export const ok = 1;\n");
  }
  const result = await runViteDoctor({ root, cache: false, mcp: [{ url: server.url }] });

  const pack = result.rulePacks?.find((item) => item.name === "vite-doctor/mcp");
  expect(pack?.selected).toBe(true);
  expect(pack?.activatedBy).toEqual(expect.arrayContaining(["packages/a", "packages/b"]));
});

test("an evidence-only Rule Pack requires matching Runtime Evidence", async () => {
  const create = vi.fn(() => ({}));
  const rule = createRule({
    meta: {
      id: "acme/check",
      title: "Check Acme evidence",
      category: "architecture",
      severity: "warn",
      execution: "workspace",
    },
    create,
  });
  const pack = defineRulePack({
    name: "acme",
    version: "1.0.0",
    activation: { runtimeEvidence: (evidence) => "acme" in evidence },
    rules: [rule],
    presets: { recommended: [rule.meta.id] },
  });
  const root = project();
  const extension = { name: "fixture/acme", rulePacks: [pack] };
  const without = await runDoctor({ root, cache: false, extensions: [extension] });
  expect(without.rulePacks).toEqual([]);
  expect(create).not.toHaveBeenCalled();

  const withEvidence = await runDoctor({
    root,
    cache: false,
    extensions: [
      extension,
      {
        name: "fixture/acme-evidence",
        setup(api) {
          api.registerRuntimeEvidenceContributor({ name: "acme", contribute: () => ({}) });
        },
      },
    ],
  });
  expect(withEvidence.rulePacks).toEqual([{ name: "acme", selected: true, activatedBy: ["."] }]);
  expect(create).toHaveBeenCalledOnce();
});

function mockRemoteToolWithIncompatibleSchema() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const { method, id } = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    if (method === "notifications/initialized") return new Response(null, { status: 202 });
    const tools = [
      { name: "remote", inputSchema: { type: "object", properties: { "page size": {} } } },
    ];
    return Response.json({ id, result: method === "initialize" ? {} : { tools } });
  });
}

test("fetched MCP evidence is not reported as used when client Rules are filtered out", async () => {
  mockRemoteToolWithIncompatibleSchema();
  const options = { root: project(), cache: false, mcp: [{ url: "https://example.test/mcp" }] };
  const checked = await runViteDoctor(options);
  expect(checked.diagnostics.map(({ code }) => code)).toContain("MCP0005");
  expect(checked.project.evidenceUsed).toEqual([
    { source: "mcp", message: "tools/list of the MCP server at https://example.test, 1 tool" },
  ]);
  for (const filter of [{ rules: "typescript/*" }, { analyses: "graph" }]) {
    const result = await runViteDoctor({ ...options, ...filter });
    expect(readMcpServers(result.project.runtimeEvidence)).toHaveLength(1);
    expect(reportStatus(result)).toBe("clean");
    expect(result.project.evidenceUsed).toBeUndefined();
    expect(createReport(result, "text")).not.toContain("Evidence used:");
  }
});

test("MCP tool Rules that check the tools a server sends report its evidence as used", async () => {
  mockRemoteToolWithIncompatibleSchema();
  const result = await runViteDoctor({
    root: project(),
    cache: false,
    mcp: [{ url: "https://example.test/mcp" }],
    rules: "mcp/tools/*",
  });
  expect(result.diagnostics.map(({ code }) => code)).toContain("MCP0001");
  expect(result.project.evidenceUsed).toEqual([
    { source: "mcp", message: "tools/list of the MCP server at https://example.test, 1 tool" },
  ]);
});

test("only project-wide client Rules cover remote-only MCP tools without the MCP Preset", async () => {
  mockRemoteToolWithIncompatibleSchema();
  const options = {
    root: project(),
    cache: false,
    extends: ["vite-doctor/typescript/recommended"],
    mcp: [{ url: "https://example.test/mcp" }],
  };
  const rules = { "mcp/clients/no-excluded-tool": "error" } as const;
  const fileOnly = await runViteDoctor({
    ...options,
    config: { overrides: [{ files: ["index.ts"], rules }] },
  });
  expect(fileOnly.diagnostics.map(({ code }) => code)).not.toContain("MCP0005");
  expect(reportStatus(fileOnly)).toBe("incomplete");
  expect(fileOnly.project.evidenceUsed).toBeUndefined();

  const titleOnly = await runViteDoctor({
    ...options,
    config: { rules: { "mcp/tools/require-annotation-title": "error" } },
  });
  expect(titleOnly.diagnostics.map(({ code }) => code)).toContain("MCP0001");
  expect(reportStatus(titleOnly)).toBe("incomplete");
  expect(titleOnly.project.evidenceUsed).toHaveLength(1);
  expect(createReport(titleOnly, "text")).toContain("no MCP client Rule checked them project-wide");

  const projectWide = await runViteDoctor({ ...options, config: { rules } });
  expect(projectWide.diagnostics.map(({ code }) => code)).toContain("MCP0005");
  expect(projectWide.project.evidenceGaps ?? []).toHaveLength(0);
  expect(projectWide.project.evidenceUsed).toEqual([
    { source: "mcp", message: "tools/list of the MCP server at https://example.test, 1 tool" },
  ]);
});

test("a file override reports scoped MCP evidence without clearing the project-wide gap", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const { method, id } = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    if (method === "notifications/initialized") return new Response(null, { status: 202 });
    const name = String(url).includes("other.test") ? "other" : "remote";
    const tools = [{ name, inputSchema: { type: "object", properties: { "page size": {} } } }];
    return Response.json({ id, result: method === "initialize" ? {} : { tools } });
  });
  const root = project(mcpServerPackage);
  const file = join(root, "index.ts");
  writeFileSync(
    file,
    `
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
const server = new McpServer({ name: 'fixture', version: '1' })
server.registerTool('remote', {}, async () => ({ content: [] }))
`,
  );
  const result = await runViteDoctor({
    root,
    cache: false,
    extends: ["vite-doctor/typescript/recommended"],
    config: {
      overrides: [{ files: ["index.ts"], rules: { "mcp/clients/no-excluded-tool": "error" } }],
    },
    mcp: [{ url: "https://example.test/mcp" }, { url: "https://other.test/mcp" }],
  });
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "MCP0005", file }));
  expect(reportStatus(result)).toBe("incomplete");
  expect(result.project.evidenceUsed).toEqual([
    {
      source: "mcp",
      message: "tools/list of the MCP server at https://example.test, 1 tool (file overrides only)",
    },
  ]);
  const text = createReport(result, "text");
  expect(text).toContain(
    "read the tools of https://example.test, https://other.test as Runtime Evidence, but no MCP client Rule checked them project-wide",
  );
});

test("an extends list that leaves out the MCP Rule Pack leaves an evidence gap", async () => {
  const server = await stub();
  const result = await runViteDoctor({
    root: project(),
    cache: false,
    extends: ["vite-doctor/typescript/recommended"],
    mcp: [{ url: server.url }],
  });

  expect(reportStatus(result)).toBe("incomplete");
  expect(result.project.evidenceUsed).toBeUndefined();
  expect(result.project.evidenceGaps).toEqual([
    expect.objectContaining({
      source: "mcp",
      message: expect.stringContaining(
        `${new URL(server.url).origin} as Runtime Evidence, but no MCP client Rule checked them project-wide`,
      ),
    }),
  ]);
});

test("readMcpServers collects mcpServers from every contributor and skips malformed entries", () => {
  expect(
    readMcpServers({
      mcp: { mcpServers: [{ url: "http://a/mcp", tools: [{ name: "a" }] }] },
      vitehub: {
        mcpServers: [{ name: "hub", tools: [{ name: "b" }] }, { tools: [{}] }, { error: "x" }],
      },
      other: { mcpServers: [{ name: "ok", error: null, tools: [{ name: "c" }] }] },
      vite: { other: true },
    }),
  ).toEqual([
    { url: "http://a/mcp", tools: [{ name: "a" }] },
    { name: "hub", tools: [{ name: "b" }] },
    { name: "ok", error: null, tools: [{ name: "c" }] },
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
  expect(output).not.toMatch(/query-secret|Bearer secret|X-Team: drops/);
  const report = JSON.parse(output) as {
    commandArgs: { rerun: string[] };
    placeholders: Record<string, string>;
  };
  expect(report.commandArgs.rerun).toEqual([
    "vite-doctor",
    ".",
    "--framework",
    "vite",
    "--mcp-url",
    `${first.url}/path-secret?token=<redacted>`,
    "--mcp-url",
    second.url,
    "--mcp-header",
    "Authorization: <redacted>",
    "--mcp-header",
    "X-Team: <redacted>",
    "--no-cache",
    "--format",
    "agent",
  ]);
  expect(report.placeholders["<redacted>"]).toContain("--mcp-header values");
});

test("--mcp-url checks a server from an empty directory, naming Doctor as the client", async () => {
  const requests: StubRequest[] = [];
  const server = await stub({ requests, tools: [{ name: "search" }] });
  const root = mkdtempSync(join(tmpdir(), "doctor-mcp-empty-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const { code, output } = await cli(root, [
    "--no-cache",
    "--format",
    "json",
    "--mcp-url",
    server.url,
  ]);

  expect(code).toBe(0);
  expect(requests.find((request) => request.method === "initialize")?.clientInfo).toEqual({
    name: "vite-doctor",
    version: viteDoctorVersion,
  });
  const report = JSON.parse(output) as {
    status: string;
    subject: unknown;
    framework: unknown;
    rulePacks: Array<{ name: string }>;
    diagnostics: Array<{ code: string }>;
  };
  expect(report.status).toBe("findings");
  expect(report.subject).toEqual({ mcpServers: [new URL(server.url).origin] });
  expect(report.framework).toBeNull();
  expect(report.rulePacks.map((pack) => pack.name)).toEqual(["vite-doctor/mcp"]);
  expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["MCP0001", "MCP0002"]);
});

function emptyDirectory() {
  const root = mkdtempSync(join(tmpdir(), "doctor-mcp-empty-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("an MCP server checked from an empty directory is the report's subject, not a project", async () => {
  const server = await stub({ tools: [{ name: "search" }, { name: "fetch" }] });
  const root = emptyDirectory();
  const agent = await cli(root, ["--no-cache", "--format", "agent", "--mcp-url", server.url]);
  const report = JSON.parse(agent.output) as {
    subject: unknown;
    project: unknown;
    rulePacks: Array<{ name: string }>;
    commandArgs: Record<string, string[]>;
  };
  expect(report.subject).toEqual({ mcpServers: [new URL(server.url).origin] });
  expect(report.project).toBeNull();
  expect(report.rulePacks.map((pack) => pack.name)).toEqual(["vite-doctor/mcp"]);
  expect(report.commandArgs.rerun).toEqual([
    "vite-doctor",
    "--mcp-url",
    server.url,
    "--no-cache",
    "--format",
    "agent",
  ]);
  expect(report.commandArgs.explain).toEqual([
    "vite-doctor",
    "explain",
    "<code>",
    "--format",
    "agent",
  ]);
  expect(report).not.toHaveProperty("placeholders");

  const text = await cli(root, [
    "--no-cache",
    "--format",
    "text",
    "--full",
    "--mcp-url",
    server.url,
  ]);
  expect(text.output).toContain(`Checked: MCP server ${new URL(server.url).origin}\n`);
  expect(text.output).toContain(`Project: none, ${root} has no package.json\n`);
  expect(text.output).not.toMatch(/Detected:|Vite/);
});

test("the text report prints evidence every Diagnostic of a group shares once", async () => {
  const server = await stub({ tools: [{ name: "search" }, { name: "fetch" }, { name: "list" }] });
  const { output } = await cli(emptyDirectory(), [
    "--no-cache",
    "--format",
    "text",
    "--full",
    "--mcp-url",
    server.url,
  ]);
  const group = output.slice(output.indexOf("MCP0001  "), output.indexOf("MCP0002  "));
  const read = `evidence: runtime: Read from the tools/list of MCP server "stub" at ${new URL(server.url).origin} during this Doctor Run.`;
  expect(group.split(read)).toHaveLength(2);
  expect(group.indexOf(read)).toBeLessThan(group.indexOf("[MCP0001]"));
  for (const tool of ["search", "fetch", "list"]) expect(group).toContain(`source: ${tool}\n`);
});

test("an MCP server that answers 401 from an empty directory reports missing MCP server evidence", async () => {
  const server = await stub({ token: "secret" });
  const { code, output } = await cli(emptyDirectory(), [
    "--no-cache",
    "--format",
    "text",
    "--mcp-url",
    server.url,
  ]);
  expect(code).toBe(3);
  expect(output).toContain("Status: incomplete, required MCP server evidence is missing\n");
  expect(output).toMatch(
    /Evidence missing: .*HTTP 401.*--mcp-header "Authorization: Bearer <token>"\.\n/,
  );
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
