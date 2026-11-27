import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { McpTool } from "@loadsheet/mcp";
import { join } from "pathe";
import { afterEach, expect, test } from "vite-plus/test";
import type { Diagnostic, DoctorRunOptions } from "../../src/core/index.ts";
import { createDiagnosticFingerprint } from "../../src/core/internal/diagnostics.ts";
import { runViteDoctor } from "../../src/doctor.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const tool = (annotations: string) =>
  `import { defineMcpTool } from 'nitro-mcp-toolkit'\nexport default defineMcpTool({\n  name: 'list_drops',\n  title: 'List drops',\n  annotations: ${annotations},\n  handler: () => [],\n})\n`;

function project(annotations = "{ readOnlyHint: true }") {
  const root = mkdtempSync(join(tmpdir(), "doctor-mcp-origin-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      type: "module",
      dependencies: { "nitro-mcp-toolkit": "^0.4.0", h3: "^2.0.0" },
    }),
  );
  mkdirSync(join(root, "server/mcp/tools"), { recursive: true });
  writeFileSync(join(root, "server/mcp/tools/list_drops.ts"), tool(annotations));
  writeFileSync(join(root, "server/other.ts"), "export const other = 1;\n");
  return root;
}

function server(
  tools: McpTool[],
  urls = ["https://mcp.example.com/mcp"],
): NonNullable<DoctorRunOptions["extensions"]> {
  return [
    {
      name: "fixture/server",
      setup(api) {
        api.registerRuntimeEvidenceContributor({
          name: "server",
          contribute: () => ({ mcpServers: urls.map((url) => ({ url, tools })) }),
        });
      },
    },
  ];
}

async function run(root: string, options: Partial<DoctorRunOptions> = {}) {
  const result = await runViteDoctor({ root, cache: false, extends: "auto", ...options });
  return result.diagnostics.filter((diagnostic) => diagnostic.code.startsWith("MCP"));
}

const byCode = (diagnostics: Diagnostic[], code: string) =>
  diagnostics.find((diagnostic) => diagnostic.code === code);

const live = [{ source: "mcp", target: "https://mcp.example.com" }];

const sent = (annotations: McpTool["annotations"]): McpTool => ({
  name: "list_drops",
  title: "List drops",
  inputSchema: { type: "object", properties: {} },
  annotations,
});

test("a finding the source and the server share keeps its fingerprint when the server is added", async () => {
  const root = project();
  const code = byCode(await run(root), "MCP0001");
  const both = byCode(
    await run(root, { extensions: server([sent({ readOnlyHint: true })]) }),
    "MCP0001",
  );
  expect(code?.origin).toBeUndefined();
  expect(both?.origin).toEqual({ code: "found", live });
  expect(both?.fingerprint).toBe(code?.fingerprint);
  expect(both?.file).toBe(code?.file);

  const confirmed = (
    await run(root, {
      extensions: server(
        [sent({ readOnlyHint: true })],
        ["https://second.example.com/mcp", "https://mcp.example.com/mcp"],
      ),
    })
  ).filter((diagnostic) => diagnostic.code === "MCP0001");
  expect(confirmed).toHaveLength(1);
  expect(confirmed[0]?.fingerprint).toBe(code?.fingerprint);
  expect(confirmed[0]?.origin).toEqual({
    code: "found",
    live: [{ source: "mcp", target: "https://second.example.com" }, ...live],
  });
});

test("a wire finding absent from the source reports the definition as passing", async () => {
  const root = project("{ title: 'List drops', readOnlyHint: true }");
  expect(byCode(await run(root), "MCP0001")).toBeUndefined();
  const stale = byCode(
    await run(root, { extensions: server([sent({ readOnlyHint: true })]) }),
    "MCP0001",
  );
  expect(stale?.origin).toEqual({ code: "passes", live });
  expect(stale?.file).toBe(join(root, "server/mcp/tools/list_drops.ts"));
});

test.each(["MCP0001", "MCP0010"])("%s baselines identify each live-only endpoint", async (code) => {
  const root = project("{ title: 'List drops', readOnlyHint: true }");
  const first = "https://mcp.example.com/first";
  const second = "https://mcp.example.com/second";
  const tools = [sent(code === "MCP0001" ? { readOnlyHint: true } : { title: false })];
  const baseline = "baseline.json";
  const findings = async (urls: string[], options: Partial<DoctorRunOptions> = {}) =>
    (await run(root, { extensions: server(tools, urls), ...options }))
      .filter((item) => item.code === code)
      .map((item) => item.fingerprint);

  const known = await findings([first], { baseline, updateBaseline: true });
  const other = await findings([second]);
  expect(known).toHaveLength(1);
  expect(other).toHaveLength(1);
  expect(await findings([second, first], { baseline, newOnly: true })).toEqual(other);
  expect(await findings([second], { baseline, newOnly: true })).toEqual(other);
  expect(other).not.toEqual(known);
});

test("a scheme-4 baseline warns about a changed static MCP fingerprint", async () => {
  const root = project();
  const finding = byCode(await run(root), "MCP0001")!;
  const legacy = createDiagnosticFingerprint(root, finding, readFileSync(finding.file, "utf8"));
  writeFileSync(
    join(root, "baseline.json"),
    JSON.stringify({ version: 2, fingerprintScheme: 4, diagnostics: [{ fingerprint: legacy }] }),
  );
  const result = await runViteDoctor({ root, baseline: "baseline.json", newOnly: true });
  expect(result.diagnostics.map((item) => item.code)).toEqual(
    expect.arrayContaining(["DOC0032", "MCP0001"]),
  );
});

test("affected-file runs keep only live findings located in the affected files", async () => {
  const root = project();
  const extensions = server([sent({ readOnlyHint: true })]);
  expect(await run(root, { affectedFiles: ["server/other.ts"], extensions })).toEqual([]);
  expect(
    byCode(
      await run(root, { affectedFiles: ["server/mcp/tools/list_drops.ts"], extensions }),
      "MCP0001",
    )?.origin,
  ).toEqual({ code: "found", live });
});

test("a tool only the server sends has no definition", async () => {
  const root = project("{ title: 'List drops', readOnlyHint: true }");
  const other: McpTool = { ...sent({ readOnlyHint: true }), name: "search" };
  const found = byCode(await run(root, { extensions: server([other]) }), "MCP0001");
  expect(found?.origin).toEqual({ code: "no-definition", live });
  expect(found?.subject).toBe("search");
});

test("a client limit only the server shows is not checked in source", async () => {
  const root = project("{ title: 'List drops', readOnlyHint: true }");
  const spaced: McpTool = {
    ...sent({ title: "List drops", readOnlyHint: true }),
    inputSchema: { type: "object", properties: { "page size": { type: "integer" } } },
  };
  const found = byCode(
    await run(root, { extends: ["auto", "mcp/strict"], extensions: server([spaced]) }),
    "MCP0005",
  );
  expect(found?.origin).toEqual({ code: "not-checked", live });
  expect(found?.file).toBe(join(root, "server/mcp/tools/list_drops.ts"));
});

test("--changed keeps what the server showed when the change doesn't touch the definition", async () => {
  const root = project();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init");
  git("add", ".");
  git("-c", "user.name=Doctor", "-c", "user.email=doctor@example.test", "commit", "-m", "init");
  writeFileSync(join(root, "server/other.ts"), "export const other = 2;\n");

  expect(await run(root, { changed: true })).toEqual([]);
  const scoped = await run(root, {
    changed: true,
    extensions: server([sent({ readOnlyHint: true })]),
  });
  expect(scoped.map((diagnostic) => [diagnostic.code, diagnostic.origin?.code])).toEqual([
    ["MCP0001", "found"],
  ]);
});
