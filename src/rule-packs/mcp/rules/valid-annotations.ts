import { createRule } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";
import { collectMcpTools } from "./shared.js";
import { reportWireTools, wireTools } from "./wire.js";

export const validAnnotations = createRule({
  meta: {
    id: "mcp/tools/valid-annotations",
    title: "Send MCP tool annotations as a ToolAnnotations object",
    description:
      "Report MCP tools whose `annotations` in `tools/list` are not an object, give a `ToolAnnotations` field the wrong type, or hold a serialized schema.",
    why: "MCP's `ToolAnnotations` is an object with a `title` string and the boolean hints `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`. The MCP TypeScript SDK's client rejects a whole `tools/list` response when a tool's annotations are not an object or one of those fields has another type. A serialized schema there is usually one passed in the wrong argument: the MCP SDK's `server.tool(name, description, schema, annotations, cb)` overloads took a Zod object that isn't a raw shape as the annotations before version 1.32.2, which now throws instead. Clients drop its fields, so the tool has no title or safety hints, and it ships with an empty input schema, so the model calls it without the arguments it needs.",
    recommendedReplacement:
      "Send `annotations` as `{ title, readOnlyHint }` or `{ title, destructiveHint }`, and pass the input schema as a raw Zod shape or an object-root schema.",
    examples: [
      {
        title: "Pass the input schema where the SDK expects it",
        language: "ts",
        invalid:
          "server.tool(\n  'fetch_docs',\n  'Fetch the documentation.',\n  z.object({ path: z.string() }),\n  async ({ path }) => fetchDocs(path),\n)",
        valid:
          "server.registerTool(\n  'fetch_docs',\n  {\n    description: 'Fetch the documentation.',\n    inputSchema: { path: z.string() },\n    annotations: { title: 'Fetch docs', readOnlyHint: true },\n  },\n  async ({ path }) => fetchDocs(path),\n)",
      },
    ],
    category: "tools",
    severity: "warn",
    confidence: "runtime-backed",
    fixable: false,
    diagnosticCodes: ["MCP0010"],
    docsUrl: "https://modelcontextprotocol.io/specification/2025-11-25/schema#toolannotations",
    execution: "workspace",
    cacheScope: "none",
    requires: { crossFile: true },
    requiresContext: ["cross-file"],
    consumesEvidence: ["runtime", "ast"],
    determinism: "runtime-dependent",
    cost: "small",
  },
  create(ctx) {
    return {
      async onWorkspaceEnd() {
        const { tools } = wireTools(ctx, await collectMcpTools(ctx));
        reportWireTools(ctx, tools, "MCP0010", {
          ruleId: "mcp/tools/valid-annotations",
          diagnostic: diagnostics.MCP0010,
          range: (tool) =>
            tool.annotations.state === "absent" ? tool.callee : tool.annotations.range,
        });
      },
    };
  },
});
