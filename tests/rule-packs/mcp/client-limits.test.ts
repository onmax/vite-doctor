import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "pathe";
import { afterEach, expect, test } from "vite-plus/test";
import type { Diagnostic, DoctorRunOptions } from "../../../src/core/index.ts";
import { runViteDoctor } from "../../../src/doctor.ts";
import { mcpClientRules } from "../../../src/mcp/index.ts";
import type { McpServerEvidence } from "../../../src/mcp/evidence.ts";
import type { McpTool } from "../../../src/mcp/types.ts";
import { MCP_CLIENT_LABELS } from "../../../src/rule-packs/mcp/rules/client-limits.ts";
import { startMcpStub } from "../../mcp/mcp-stub.ts";

const cleanups: Array<() => unknown> = [];

afterEach(async () => {
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

test("in a monorepo with two MCP packages, a tool with no source in them is reported at the root", async () => {
  const mcpPackage = (name: string) =>
    JSON.stringify({ name, dependencies: { "nitro-mcp-toolkit": "^0.4.0" } });
  const root = project({
    "package.json": JSON.stringify({ name: "workspace", private: true }),
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    "packages/a/package.json": mcpPackage("a"),
    "packages/b/package.json": mcpPackage("b"),
    "packages/c/package.json": JSON.stringify({ name: "c" }),
    "packages/c/server/mcp/tools/search.ts": searchSource,
  });
  const { diagnostics } = await run(root, {
    extends: ["auto"],
    extensions: contributing([
      { name: "hub", initialize: { instructions: "Drops." }, tools: [search, lookup] },
    ]),
  });

  expect(summary(root, diagnostics)).toEqual(["MCP0005 error .", "MCP0005 error ."]);
});

test("without a package that depends on an MCP library, every tool is reported at the root", async () => {
  const root = project({
    "package.json": JSON.stringify({ type: "module" }),
    "server/mcp/tools/search.ts": searchSource,
  });
  const { diagnostics } = await run(root, {
    extensions: contributing([{ name: "remote", tools: [search, lookup] }]),
  });

  expect(summary(root, diagnostics)).toEqual([
    "MCP0005 error .",
    "MCP0005 error .",
    "MCP0007 warn .",
    "MCP0008 warn .",
  ]);
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
  expect(context.evidence?.[0]?.summary).toContain(server.url);
});

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

test("a server a Doctor Extension could not read leaves an evidence gap", async () => {
  const root = project();
  const { result, diagnostics } = await run(root, {
    extensions: contributing([{ url: "http://127.0.0.1:1/mcp", error: "connection refused" }]),
  });
  expect(diagnostics).toEqual([]);
  expect(result.project.evidenceGaps).toEqual([
    expect.objectContaining({
      source: "mcp",
      message: expect.stringContaining("http://127.0.0.1:1/mcp, so its tools were not checked"),
    }),
  ]);
});

test("a client renaming a tool is reported beside MCP0003, whose fix may not cover it", async () => {
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
    "MCP0007 info server/mcp/tools/list_orders.ts:2",
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
