import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "pathe";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { createReport, type Diagnostic, type DoctorRunOptions } from "../../../src/core/index.ts";
import { writeBaseline } from "../../../src/core/internal/diagnostic-policy.ts";
import { runViteDoctor } from "../../../src/doctor.ts";
import { mcpClientRules } from "../../../src/mcp/index.ts";
import type { McpServerEvidence } from "../../../src/mcp/evidence.ts";
import type { McpTool } from "../../../src/mcp/types.ts";
import { MCP_CLIENT_LABELS } from "../../../src/rule-packs/mcp/rules/wire.ts";
import { startMcpStub } from "../../mcp/mcp-stub.ts";

const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const annotated = { annotations: { title: "T", readOnlyHint: true } };

// Root anyOf, `$ref`, and a numeric `exclusiveMinimum`.
const search: McpTool = {
  name: "search",
  description: "Search drops.",
  ...annotated,
  inputSchema: {
    anyOf: [
      {
        type: "object",
        properties: {
          size: { type: "integer", exclusiveMinimum: 0 },
          filter: { $ref: "#/$defs/filter" },
        },
      },
      { type: "object", properties: { id: { type: "string" } } },
    ],
    $defs: { filter: { type: "string" } },
  },
};

// A top-level property name with a space; no tool of this name exists in source.
const lookup: McpTool = {
  name: "lookup",
  description: "Look up a drop.",
  ...annotated,
  inputSchema: { type: "object", properties: { "page size": { type: "integer" } } },
};

const searchSource = `import { defineMcpTool } from 'nitro-mcp-toolkit'
export default defineMcpTool({
  name: 'search',
  title: 'Search',
  annotations: { title: 'Search', readOnlyHint: true },
  handler: () => [],
})
`;

function project(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "doctor-mcp-client-limits-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const all: Record<string, string> = {
    "package.json": JSON.stringify({
      type: "module",
      dependencies: { "nitro-mcp-toolkit": "^0.4.0", h3: "^2.0.0" },
    }),
    ...files,
  };
  for (const [file, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

function contributing(mcpServers: McpServerEvidence[]): DoctorRunOptions["extensions"] {
  return [
    {
      name: "fixture/vitehub",
      setup(api) {
        api.registerRuntimeEvidenceContributor({
          name: "vitehub",
          contribute: () => ({ mcpServers }),
        });
      },
    },
  ];
}

async function run(root: string, options: DoctorRunOptions = {}) {
  const result = await runViteDoctor({
    root,
    cache: false,
    extends: ["auto", "mcp/strict"],
    ...options,
  });
  return {
    result,
    diagnostics: result.diagnostics.filter((diagnostic) => /^MCP000[5-9]$/.test(diagnostic.code)),
    all: result.diagnostics.filter((diagnostic) => diagnostic.code.startsWith("MCP")),
  };
}

function summary(root: string, diagnostics: Diagnostic[]) {
  return diagnostics
    .map(
      (item) =>
        `${item.code} ${item.severity} ${relative(root, item.file) || "."}${item.range ? `:${item.range.line}` : ""}`,
    )
    .sort();
}

function byCode(diagnostics: Diagnostic[], code: string, tool: string) {
  return diagnostics.find((item) => item.code === code && item.why.includes(`Tool \`${tool}\``));
}

test("auto reports unowned remote tool findings at the workspace root", async () => {
  const manifest = JSON.stringify({ dependencies: { "@modelcontextprotocol/sdk": "^1.32.0" } });
  const root = project({
    "package.json": '{"name":"workspace"}',
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    "packages/a/package.json": manifest,
    "packages/a/index.ts": "export const a = 1;",
    "packages/b/package.json": manifest,
    "packages/b/index.ts": "export const b = 1;",
  });
  const { diagnostics } = await run(root, {
    extends: "auto",
    extensions: contributing([{ name: "remote", tools: [lookup] }]),
  });
  expect(summary(root, diagnostics)).toContain("MCP0005 error .");
});

test("only an explicit client alias affects alias-based exclusions", async () => {
  const root = project();
  const name = "s".repeat(73);
  const server = {
    name,
    initialize: { serverInfo: { name } },
    tools: [{ ...annotated, name: "t".repeat(65), inputSchema: { type: "object" } }],
  };
  for (const clientAlias of [undefined, name]) {
    const { diagnostics } = await run(root, {
      extensions: contributing([{ ...server, clientAlias }]),
    });
    expect(
      diagnostics.some((item) => item.code === "MCP0005" && item.why.includes("Claude Code")),
    ).toBe(clientAlias !== undefined);
  }
});

test("a Doctor Extension's mcpServers produce client-limit Diagnostics at the tool's source or the root", async () => {
  const root = project({ "server/mcp/tools/search.ts": searchSource });
  const { diagnostics } = await run(root, {
    extensions: contributing([
      {
        name: "hub",
        initialize: { instructions: "Search and look up drops." },
        tools: [search, lookup],
      },
    ]),
  });

  expect(summary(root, diagnostics)).toEqual([
    "MCP0005 error .",
    "MCP0005 error server/mcp/tools/search.ts:3",
    "MCP0007 warn server/mcp/tools/search.ts:3",
    "MCP0008 warn server/mcp/tools/search.ts:3",
  ]);

  const excluded = byCode(diagnostics, "MCP0005", "search")!;
  expect(excluded.why).toContain('Tool `search` of MCP server "hub" is left out');
  expect(excluded.why).toContain("in Copilot Studio.");
  expect(excluded.why).toContain("System.FormatException");
  expect(excluded.why).toContain("uses `$ref`");
  expect(excluded.confidence).toBe("runtime-backed");
  expect(excluded.evidence?.map((item) => item.summary).join("\n")).toContain(
    "https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-troubleshooting",
  );
  expect(excluded.evidence?.some((item) => item.summary.includes("checked 2026-11-25"))).toBe(true);
  expect(excluded.evidence?.at(-1)).toMatchObject({ kind: "ast", range: { line: 3 } });

  const stripped = byCode(diagnostics, "MCP0008", "search")!;
  expect(stripped.why).toContain("in Codex and VS Code.");
  expect(stripped.data).toMatchObject({
    server: { name: "hub" },
    tool: "search",
    findings: expect.arrayContaining([
      expect.objectContaining({ client: "codex", tool: "search" }),
      expect.objectContaining({ client: "vscode", tool: "search" }),
    ]),
  });

  const remote = byCode(diagnostics, "MCP0005", "lookup")!;
  expect(remote.file).toBe(root);
  expect(remote.range).toBeUndefined();
  expect(remote.why).toContain("in Claude Code.");
  expect(remote.why).toContain('"page size"');
  expect(remote.fingerprint).toMatch(/^[0-9a-f]{64}$/);

  const again = await run(root, {
    extensions: contributing([
      { name: "hub", initialize: { instructions: "Search and look up drops." }, tools: [lookup] },
    ]),
  });
  expect(byCode(again.diagnostics, "MCP0005", "lookup")!.fingerprint).toBe(remote.fingerprint);
});

test("structured reports retain pointers omitted from the client-limit message", async () => {
  const names = ["first", "second", "third", "fourth", "fifth", "sixth"];
  const tool: McpTool = {
    ...search,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        names.map((name) => [name, { type: "integer", exclusiveMinimum: 0 }]),
      ),
    },
  };
  const { diagnostics, result } = await run(project(), {
    extensions: contributing([{ name: "hub", tools: [tool] }]),
  });
  const stripped = byCode(diagnostics, "MCP0008", tool.name)!;
  expect(stripped.why).toContain("and 1 more");
  expect(stripped.why).not.toContain("/inputSchema/properties/sixth");
  const expected = {
    server: { name: "hub" },
    tool: tool.name,
    findings: expect.arrayContaining([
      expect.objectContaining({
        rule: "codex/dropped-constraints",
        affectedPointers: names.map((name) => `/inputSchema/properties/${name}/exclusiveMinimum`),
      }),
    ]),
  };
  for (const format of ["json", "agent"] as const) {
    const report = JSON.parse(createReport(result, format)) as {
      diagnostics: Array<{ fingerprint: string; data?: unknown }>;
    };
    const data = report.diagnostics.find((item) => item.fingerprint === stripped.fingerprint)?.data;
    expect(data).toMatchObject(expected);
    expect(data).toEqual(stripped.data);
  }
  const sarif = JSON.parse(createReport(result, "sarif")) as {
    runs: Array<{
      results: Array<{
        partialFingerprints: Record<string, string>;
        properties: { data?: unknown };
      }>;
    }>;
  };
  const data = sarif.runs[0]!.results.find(
    (item) => item.partialFingerprints["vite-doctor/v1"] === stripped.fingerprint,
  )?.properties.data;
  expect(data).toMatchObject(expected);
  expect(data).toEqual(stripped.data);
});

test("tools read from a running server through the mcp option are checked", async () => {
  const server = await startMcpStub({ tools: [search, lookup] });
  cleanups.push(server.close);
  const root = project();
  const { diagnostics } = await run(root, { mcp: [{ url: server.url }] });

  expect(summary(root, diagnostics)).toEqual([
    "MCP0005 error .",
    "MCP0005 error .",
    "MCP0007 warn .",
    "MCP0008 warn .",
    "MCP0009 info .",
  ]);
  const context = diagnostics.find((item) => item.code === "MCP0009")!;
  expect(context.why).toContain(
    'MCP server "stub" reaches the model with less context in Claude Code.',
  );
  expect(context.evidence?.[0]?.summary).toContain(new URL(server.url).origin);
  expect(context.evidence?.[0]?.summary).not.toContain(server.url);
});

test.each([false, true])(
  "same-origin MCP endpoints have separate baselines (source match: %s)",
  async (sourceMatch) => {
    vi.stubGlobal("fetch", async (_url: URL, request: RequestInit) => {
      const { id, method } = JSON.parse(typeof request.body === "string" ? request.body : "{}");
      if (method === "notifications/initialized") return new Response(null, { status: 202 });
      const result =
        method === "initialize" ? { serverInfo: { name: "stub" } } : { tools: [lookup] };
      return Response.json({ jsonrpc: "2.0", id, result });
    });
    const root = project(
      sourceMatch
        ? { "server/mcp/tools/lookup.ts": searchSource.replace("name: 'search'", "name: 'lookup'") }
        : {},
    );
    const first = { url: "https://example.test/private-a?token=secret-a" };
    const second = { url: "https://example.test/private-b?token=secret-b" };
    const exclusions = (diagnostics: Diagnostic[]) =>
      diagnostics.filter((item) => item.code === "MCP0005");

    const initial = await run(root, { mcp: [first] });
    const [known] = exclusions(initial.diagnostics);
    expect(known?.range !== undefined).toBe(sourceMatch);
    writeBaseline(root, "baseline.json", initial.diagnostics);

    const combined = await run(root, { mcp: [second, first] });
    const findings = exclusions(combined.diagnostics);
    expect(findings).toHaveLength(2);
    expect(new Set(findings.map((item) => item.fingerprint)).size).toBe(2);
    expect(JSON.stringify(findings)).not.toMatch(/private-[ab]|secret-[ab]/);

    const filtered = await run(root, {
      mcp: [first, second],
      baseline: "baseline.json",
      newOnly: true,
    });
    const standalone = await run(root, { mcp: [second] });
    expect(exclusions(filtered.diagnostics).map((item) => item.fingerprint)).toEqual(
      exclusions(standalone.diagnostics).map((item) => item.fingerprint),
    );
  },
);

test.each(["HTTP", "extension"])(
  "a baseline tracks MCP exclusion locations from %s",
  async (source) => {
    const root = project({
      "server/mcp/tools/lookup.ts": searchSource.replace("name: 'search'", "name: 'lookup'"),
    });
    const limit = { type: "integer", exclusiveMinimum: 0 };
    const copilotProperties = { first: limit, second: limit };
    const claudeProperty = { "page size": { type: "integer" } };
    let properties: Record<string, unknown> = copilotProperties;
    vi.stubGlobal("fetch", async (_url: URL, request: RequestInit) => {
      const { id, method } = JSON.parse(typeof request.body === "string" ? request.body : "{}");
      if (method === "notifications/initialized") return new Response(null, { status: 202 });
      const result =
        method === "initialize"
          ? { serverInfo: { name: "stub" } }
          : { tools: [{ ...lookup, inputSchema: { type: "object", properties } }] };
      return Response.json({ jsonrpc: "2.0", id, result });
    });
    const options = (): DoctorRunOptions =>
      source === "HTTP"
        ? { mcp: [{ url: "https://example.test/mcp" }] }
        : {
            extensions: contributing([
              { name: "stub", tools: [{ ...lookup, inputSchema: { type: "object", properties } }] },
            ]),
          };
    const baseline = "baseline.json";
    const exclusions = (diagnostics: Diagnostic[]) =>
      diagnostics.filter((item) => item.code === "MCP0005");
    const initial = await run(root, options());
    const [known] = exclusions(initial.diagnostics);
    expect(known?.range).toBeDefined();
    expect(known?.why).toContain("Copilot Studio");
    writeBaseline(root, baseline, initial.diagnostics);

    properties = { second: limit, first: limit };
    const reordered = await run(root, { ...options(), baseline, newOnly: true });
    expect(exclusions(reordered.diagnostics)).toEqual([]);

    properties = { first: limit, third: limit };
    const replaced = await run(root, { ...options(), baseline, newOnly: true });
    expect(exclusions(replaced.diagnostics)).toEqual([
      expect.objectContaining({
        why: expect.stringContaining("/properties/third/exclusiveMinimum"),
      }),
    ]);

    properties = claudeProperty;
    const changed = await run(root, { ...options(), baseline, newOnly: true });
    expect(exclusions(changed.diagnostics)).toEqual([
      expect.objectContaining({ why: expect.stringContaining("Claude Code") }),
    ]);

    properties = { ...copilotProperties, ...claudeProperty };
    const combined = await run(root, options());
    expect(exclusions(combined.diagnostics)).toEqual([
      expect.objectContaining({ why: expect.stringContaining("Claude Code and Copilot Studio") }),
    ]);
  },
);

test("the Recommended Preset reports only excluded tools and truncated text", async () => {
  const server = await startMcpStub({ tools: [search, lookup] });
  cleanups.push(server.close);
  const root = project();
  const { diagnostics } = await run(root, { extends: ["auto"], mcp: [{ url: server.url }] });

  expect([...new Set(diagnostics.map((item) => item.code))]).toEqual(["MCP0005"]);
});

test("without MCP evidence the client-limit Rules report nothing and leave no gap", async () => {
  const root = project({ "server/mcp/tools/search.ts": searchSource });
  const { result, diagnostics } = await run(root);

  expect(diagnostics).toEqual([]);
  expect(result.project.evidenceGaps ?? []).toEqual([]);
});

test("a server Doctor could not read is skipped", async () => {
  const root = project();
  const { diagnostics } = await run(root, {
    extensions: contributing([{ url: "http://127.0.0.1:1/mcp", error: "connection refused" }]),
  });
  expect(diagnostics).toEqual([]);
});

test("client findings that repeat MCP0001 to MCP0003 are not reported again", async () => {
  const root = project({
    "server/mcp/tools/list_orders.ts": `import { defineMcpTool } from 'nitro-mcp-toolkit'
export default defineMcpTool({ name: 'list orders', handler: () => [] })
`,
  });
  const { all } = await run(root, {
    extensions: contributing([
      {
        name: "hub",
        initialize: { instructions: "Orders." },
        tools: [
          { name: "list orders", description: "List orders.", inputSchema: { type: "object" } },
        ],
      },
    ]),
  });

  expect(summary(root, all)).toEqual([
    "MCP0001 warn server/mcp/tools/list_orders.ts:2",
    "MCP0002 warn server/mcp/tools/list_orders.ts:2",
    "MCP0003 warn server/mcp/tools/list_orders.ts:2",
  ]);
});

test("each Diagnostic's severity and confidence follow its findings", async () => {
  const root = project();
  const { diagnostics } = await run(root, {
    extensions: contributing([
      {
        name: "hub",
        initialize: { instructions: "Tags." },
        tools: [
          {
            name: "tag",
            description: "Tag a drop.",
            ...annotated,
            inputSchema: { type: "object", properties: { tags: { type: "array" } } },
          },
        ],
      },
    ]),
  });

  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    code: "MCP0005",
    severity: "warn",
    confidence: "heuristic-medium",
  });
  expect(diagnostics[0]!.why).toContain("in VS Code.");
});

test("measured values reach the message", async () => {
  const root = project();
  const { diagnostics } = await run(root, {
    extensions: contributing([
      {
        name: "hub",
        initialize: { instructions: "Long." },
        tools: [
          {
            name: "long",
            description: "x".repeat(5_000),
            ...annotated,
            inputSchema: { type: "object" },
          },
        ],
      },
    ]),
  });

  const truncated = diagnostics.find((item) => item.code === "MCP0006")!;
  expect(truncated.why).toContain("Measured: 5000 characters, limit 4096.");
});

test("the MCP docs list every client the library checks", () => {
  const page = readFileSync(join(import.meta.dirname, "../../../docs/content/9.mcp.md"), "utf8");
  const section = page.split("| Client")[1]!.split("\n\n")[0]!;
  const listed = section
    .split("\n")
    .slice(2)
    .map((row) => row.split("|")[1]!.trim());
  const clients = [...new Set(mcpClientRules.map((rule) => MCP_CLIENT_LABELS[rule.client]))];
  expect(listed.sort()).toEqual(clients.sort());
});

test("MCP0001 to MCP0003 check the tools the server sends, at the matching source or the root", async () => {
  const untitled = `import { defineMcpTool } from 'nitro-mcp-toolkit'
export default defineMcpTool({
  name: 'search',
  title: 'Search',
  handler: () => [],
})
`;
  const root = project({ "server/mcp/tools/search.ts": untitled });
  const sent = (tools: McpTool[]) => contributing([{ name: "hub", tools }]);
  const object = { type: "object" };

  // The server adds the annotations that source leaves out, so neither source Rule fires.
  const fixed = await run(root, {
    extends: "auto",
    extensions: sent([{ ...search, ...annotated, inputSchema: object }]),
  });
  expect(fixed.all.filter((item) => /^MCP000[1-3]$/.test(item.code))).toEqual([]);

  // The server sends the tool as written: one runtime-backed Diagnostic per Rule, at the source.
  const asWritten = await run(root, {
    extends: "auto",
    extensions: sent([
      { name: "search", title: "Search", inputSchema: object },
      {
        name: "remote tool",
        annotations: { title: "Remote", readOnlyHint: true },
        inputSchema: object,
      },
    ]),
  });
  expect(
    summary(
      root,
      asWritten.all.filter((item) => /^MCP000[1-3]$/.test(item.code)),
    ),
  ).toEqual([
    "MCP0001 warn server/mcp/tools/search.ts:2",
    "MCP0002 warn server/mcp/tools/search.ts:2",
    "MCP0003 warn .",
  ]);
  const title = asWritten.all.find((item) => item.code === "MCP0001")!;
  expect(title.confidence).toBe("runtime-backed");
  expect(title.why).toContain('top-level title "Search"');
  expect(title.data).toMatchObject({
    server: { name: "hub" },
    tool: "search",
    findings: [{ rule: "claude-directory/missing-title" }],
  });
  const hint = asWritten.all.find((item) => item.code === "MCP0002")!;
  expect(hint.why).toContain("ChatGPT also asks the user to confirm every call");
  expect(hint.evidence?.map((item) => item.summary).join("\n")).toContain(
    "https://developers.openai.com/api/docs/guides/developer-mode",
  );
  const name = asWritten.all.find((item) => item.code === "MCP0003")!;
  expect(name.why).toContain('"remote tool" of MCP server "hub"');
  expect(name.file).toBe(root);
  // A client renaming the tool says nothing MCP0003's fix doesn't cover.
  expect(
    asWritten.all.some((item) => item.code === "MCP0007" && item.why.includes("remote tool")),
  ).toBe(false);
});

test("a wire finding from a server without a URL carries only the server name in data", async () => {
  const root = project();
  const { all } = await run(root, {
    extensions: contributing([
      { name: "hub", tools: [{ name: "untitled", annotations: { readOnlyHint: true } }] },
    ]),
  });
  expect(all.find((item) => item.code === "MCP0001")?.data).toMatchObject({
    server: { name: "hub" },
    tool: "untitled",
  });
});
