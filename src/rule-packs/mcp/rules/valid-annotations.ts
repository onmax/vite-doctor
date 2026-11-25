import { createRule } from "../../../core/index.js";
import type { McpTool } from "../../../mcp/types.js";
import { diagnostics } from "../diagnostics.js";
import { collectMcpTools } from "./shared.js";
import { annotationsProblem, reportWireTool, wireToolLabel, wireTools } from "./wire.js";

export const validAnnotations = createRule({
  meta: {
    id: "mcp/tools/valid-annotations",
    title: "Send MCP tool annotations as a ToolAnnotations object",
    description:
      "Report MCP tools whose `annotations` in `tools/list` are not an object of string and boolean values.",
    why: "MCP's `ToolAnnotations` holds only a `title` string and boolean hints. When a server sends something else there, it is almost always a schema passed in the wrong argument: the MCP SDK's `server.tool(name, description, schema, annotations, cb)` overloads took a Zod object that isn't a raw shape as the annotations before version 1.32.2, which now throws instead. The tool then reaches clients with an empty input schema, so the model calls it without the arguments it needs, and title and safety hints that clients can't read.",
    recommendedReplacement:
      "Pass the input schema as a raw Zod shape, or register the tool with `server.registerTool(name, { inputSchema, annotations }, cb)`.",
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
        for (const wire of tools) {
          const problem = annotationsProblem(wire.tool);
          if (!problem) continue;
          const empty = emptyInputSchema(wire.tool)
            ? " Its `inputSchema` is empty too, so the tool's real input schema was likely passed as the annotations and never reached clients."
            : "";
          reportWireTool(
            ctx,
            wire,
            diagnostics.MCP0010({
              why: `In its tools/list entry, MCP tool ${wireToolLabel(wire)} sends \`annotations\` that ${problem}. \`ToolAnnotations\` holds only a \`title\` string and boolean hints, so clients can't read its title or safety hints.${empty}`,
              fix: "The annotations slot got something else, likely a schema. With `server.tool()`, pass the input schema as a raw Zod shape (`{ path: z.string() }`, not `z.object(...)`), or use `server.registerTool(name, { inputSchema, annotations }, cb)`. Then set `annotations` to `{ title, readOnlyHint }` or `{ title, destructiveHint }`.",
            }),
            {
              ruleId: "mcp/tools/valid-annotations",
              range: (tool) =>
                tool.annotations.state === "absent" ? tool.callee : tool.annotations.range,
              findings: [],
            },
          );
        }
      },
    };
  },
});

function emptyInputSchema(tool: McpTool): boolean {
  const schema = tool.inputSchema;
  if (!schema) return true;
  const properties = schema.properties;
  return (
    !(properties && typeof properties === "object" && Object.keys(properties).length) &&
    !["anyOf", "oneOf", "allOf", "$ref"].some((key) => key in schema)
  );
}
