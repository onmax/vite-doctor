import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { afterEach, expect, test } from "vite-plus/test";
import type { DoctorRunOptions } from "../../../src/core/index.ts";
import { runViteDoctor } from "../../../src/doctor.ts";
import type { McpTool } from "../../../src/mcp/types.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

// What GitMCP's fetch_vite_documentation sends: a Zod union serialized into `annotations`.
const zodAnnotations = {
  _def: {
    options: [{ _def: { typeName: "ZodObject" } }, { _def: { typeName: "ZodNull" } }],
    typeName: "ZodUnion",
  },
  "~standard": { version: 1, vendor: "zod" },
};

async function run(tools: McpTool[]) {
  const root = mkdtempSync(join(tmpdir(), "doctor-mcp-annotations-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  const extensions: DoctorRunOptions["extensions"] = [
    {
      name: "fixture/server",
      setup(api) {
        api.registerRuntimeEvidenceContributor({
          name: "server",
          contribute: () => ({ mcpServers: [{ name: "docs", tools }] }),
        });
      },
    },
  ];
  const result = await runViteDoctor({ root, cache: false, extends: "auto", extensions });
  return result.diagnostics.filter((diagnostic) => /^MCP(000[1-3]|0010)$/.test(diagnostic.code));
}

const summary = (diagnostics: Awaited<ReturnType<typeof run>>) =>
  diagnostics.map((item) => `${item.code} ${item.data?.tool as string}`).sort();

test("reports a serialized Zod schema in annotations instead of a missing title and hints", async () => {
  const found = await run([
    { name: "fetch_docs", inputSchema: { type: "object" }, annotations: zodAnnotations },
  ]);
  expect(summary(found)).toEqual(["MCP0010 fetch_docs"]);
  const [diagnostic] = found;
  expect(diagnostic).toMatchObject({ severity: "warn", confidence: "runtime-backed" });
  expect(diagnostic!.why).toContain("looks like a serialized Zod schema");
  expect(diagnostic!.why).toContain("Its `inputSchema` is empty too");
  expect(diagnostic!.suggestion).toContain(
    "server.registerTool(name, { inputSchema, annotations }, cb)",
  );
});

test("reports annotations holding an array or that are not an object", async () => {
  const schema = { type: "object", properties: { q: { type: "string" } } };
  const found = await run([
    { name: "tagged", inputSchema: schema, annotations: { title: "T", tags: ["a"] } },
    { name: "listed", inputSchema: schema, annotations: [] as unknown as McpTool["annotations"] },
    { name: "named", inputSchema: schema, annotations: "T" as unknown as McpTool["annotations"] },
  ]);
  expect(summary(found)).toEqual(["MCP0010 listed", "MCP0010 named", "MCP0010 tagged"]);
  const why = (tool: string) => found.find((item) => item.data?.tool === tool)!.why;
  expect(why("tagged")).toContain("hold an object under `tags`");
  expect(why("listed")).toContain("are an array");
  expect(why("named")).toContain("are a string");
  expect(why("tagged")).not.toContain("inputSchema");
});

test("does not report valid, absent, or null annotations", async () => {
  const found = await run([
    {
      name: "valid",
      inputSchema: { type: "object" },
      annotations: { title: "Valid", readOnlyHint: true },
    },
    { name: "absent", inputSchema: { type: "object" } },
    {
      name: "nulled",
      inputSchema: { type: "object" },
      annotations: null as unknown as McpTool["annotations"],
    },
  ]);
  expect(found.map((item) => item.code)).not.toContain("MCP0010");
  expect(summary(found)).toEqual([
    "MCP0001 absent",
    "MCP0001 nulled",
    "MCP0002 absent",
    "MCP0002 nulled",
  ]);
});
