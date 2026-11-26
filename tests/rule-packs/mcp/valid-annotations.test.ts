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

async function run(tools: McpTool[], rules?: Record<string, "off">) {
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
  const result = await runViteDoctor({
    root,
    cache: false,
    extends: "auto",
    extensions,
    ...(rules ? { config: { rules } } : {}),
  });
  return result.diagnostics.filter((diagnostic) => /^MCP(000[1-3]|0010)$/.test(diagnostic.code));
}

const summary = (diagnostics: Awaited<ReturnType<typeof run>>) =>
  diagnostics.map((item) => `${item.code} ${item.data?.tool as string}`).sort();

const schema = { type: "object", properties: { q: { type: "string" } } };
const bad = (value: unknown) => value as McpTool["annotations"];

test("reports a serialized Zod schema in annotations instead of a missing title and hints", async () => {
  const found = await run([
    { name: "fetch_docs", inputSchema: { type: "object" }, annotations: zodAnnotations },
  ]);
  expect(summary(found)).toEqual(["MCP0010 fetch_docs"]);
  const [diagnostic] = found;
  expect(diagnostic).toMatchObject({ severity: "warn", confidence: "runtime-backed" });
  expect(diagnostic!.why).toContain(
    "sends a serialized schema as `annotations` (it has `_def`, `~standard`)",
  );
  expect(diagnostic!.why).toContain("Its `inputSchema` is empty too");
  expect(diagnostic!.suggestion).toContain("make optional arguments optional fields");
  expect(diagnostic!.suggestion).toContain("a root `z.union(...)` or `.nullable()`");
});

test("recognizes a serialized Zod 4 schema", async () => {
  const zod4 = { def: { type: "union", options: [] }, type: "union", options: [] };
  const found = await run([{ name: "zod4", inputSchema: schema, annotations: zod4 }]);
  expect(summary(found)).toEqual(["MCP0010 zod4"]);
  expect(found[0]!.why).toContain("(it has `def`)");
  expect(found[0]!.why).not.toContain("inputSchema");
});

test("keeps MCP0001 and MCP0002 when MCP0010 is off", async () => {
  const found = await run(
    [{ name: "fetch_docs", inputSchema: { type: "object" }, annotations: zodAnnotations }],
    { "mcp/tools/valid-annotations": "off" },
  );
  expect(summary(found)).toEqual(["MCP0001 fetch_docs", "MCP0002 fetch_docs"]);
});

test("reports annotations that are not an object, which the SDK client rejects", async () => {
  const found = await run([
    { name: "listed", inputSchema: schema, annotations: bad([]) },
    { name: "named", inputSchema: schema, annotations: bad("T") },
    { name: "nulled", inputSchema: schema, annotations: bad(null) },
  ]);
  expect(summary(found)).toEqual(["MCP0010 listed", "MCP0010 named", "MCP0010 nulled"]);
  const why = (tool: string) => found.find((item) => item.data?.tool === tool)!.why;
  expect(why("listed")).toContain("sends `annotations` as an array, not an object");
  expect(why("named")).toContain("as a string");
  expect(why("nulled")).toContain("as null");
  expect(why("nulled")).toContain("rejects the whole tools/list response");
  expect(found[0]!.suggestion).toContain("`openWorldHint` are booleans");
});

test("reports a known annotation with the wrong type", async () => {
  const found = await run([
    {
      name: "search",
      inputSchema: schema,
      annotations: bad({ title: 7, readOnlyHint: true, openWorldHint: "false" }),
    },
  ]);
  expect(summary(found)).toEqual(["MCP0010 search"]);
  expect(found[0]!.why).toContain(
    "sets `title` to a number instead of a string, `openWorldHint` to a string instead of a boolean in `annotations`",
  );
  expect(found[0]!.why).toContain("rejects the whole tools/list response");
});

test("does not report valid or absent annotations, or unknown extension fields", async () => {
  const found = await run([
    {
      name: "valid",
      inputSchema: { type: "object" },
      annotations: { title: "Valid", readOnlyHint: true },
    },
    { name: "absent", inputSchema: { type: "object" } },
    {
      name: "tagged",
      inputSchema: schema,
      annotations: { title: "Search", readOnlyHint: true, "vendor.example/tags": ["lookup"] },
    },
  ]);
  expect(found.map((item) => item.code)).not.toContain("MCP0010");
  expect(summary(found)).toEqual(["MCP0001 absent", "MCP0002 absent"]);
});

test("claims an empty input schema only for a schema that declares no arguments", async () => {
  const patterned = {
    type: "object",
    patternProperties: { "^item_": { type: "string" } },
    minProperties: 1,
    additionalProperties: false,
  };
  const sdkEmpty = {
    type: "object",
    properties: {},
    additionalProperties: false,
    $schema: "http://json-schema.org/draft-07/schema#",
  };
  const found = await run([
    { name: "patterned", inputSchema: patterned, annotations: zodAnnotations },
    { name: "sdk_empty", inputSchema: sdkEmpty, annotations: zodAnnotations },
  ]);
  const why = (tool: string) => found.find((item) => item.data?.tool === tool)!.why;
  expect(why("patterned")).not.toContain("inputSchema");
  expect(why("sdk_empty")).toContain("Its `inputSchema` is empty too");
});
