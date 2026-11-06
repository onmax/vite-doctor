import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { describe, expect, test } from "vite-plus/test";
import { runViteDoctor } from "../../../src/doctor.ts";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import {
  mcpRulePack,
  requireAnnotationTitle,
  requireSafetyHint,
  validName,
} from "../../../src/rule-packs/mcp/index.ts";

const nitroToolkit = { "nitro-mcp-toolkit": "^0.4.0", h3: "^2.0.0" };
const nuxtToolkit = { "@nuxtjs/mcp-toolkit": "^0.24.0", nuxt: "^4.0.0" };
const rules = [requireAnnotationTitle, requireSafetyHint, validName];

async function codes(
  files: Record<string, string>,
  dependencies: Record<string, string> = nitroToolkit,
) {
  const result = await runProjectFixture({ dependencies, rules, files });
  return result.diagnostics
    .filter((diagnostic) => diagnostic.code.startsWith("MCP"))
    .map((diagnostic) => `${diagnostic.code} ${relativePath(diagnostic.file)}`)
    .sort();
}

async function messages(
  files: Record<string, string>,
  dependencies: Record<string, string> = nitroToolkit,
) {
  const result = await runProjectFixture({ dependencies, rules, files });
  return result.diagnostics.filter((diagnostic) => diagnostic.code.startsWith("MCP"));
}

const tool = (options: string, from = "nitro-mcp-toolkit") =>
  `import { defineMcpTool } from '${from}'\nexport default defineMcpTool(${options})\n`;

describe("MCP tool annotations", () => {
  test("reports a tool whose annotations have no title", async () => {
    expect(
      await codes({
        "server/mcp/tools/list_drops.ts": tool(
          "{ name: 'list_drops', title: 'List drops', annotations: { readOnlyHint: true }, handler: () => [] }",
        ),
      }),
    ).toEqual(["MCP0001 server/mcp/tools/list_drops.ts"]);
  });

  test("reports both rules for a tool without annotations", async () => {
    const found = await messages({
      "server/mcp/tools/publish.ts": tool(
        "{ name: 'publish', title: 'Publish', handler: () => 'ok' }",
      ),
    });
    expect(found.map((diagnostic) => diagnostic.code).sort()).toEqual(["MCP0001", "MCP0002"]);
    expect(found.find((diagnostic) => diagnostic.code === "MCP0001")?.message).toContain(
      'top-level title "Publish"',
    );
  });

  test("accepts a title with either hint", async () => {
    expect(
      await codes({
        "server/mcp/tools/a.ts": tool(
          "{ name: 'a', annotations: { title: 'A', readOnlyHint: true }, handler: () => 1 }",
        ),
        "server/mcp/tools/b.ts": tool(
          "{ name: 'b', annotations: { title: 'B', destructiveHint: true }, handler: () => 1 }",
        ),
      }),
    ).toEqual([]);
  });

  test("resolves annotations spread from an imported constant", async () => {
    expect(
      await codes({
        "server/utils/annotations.ts":
          "export const readOnly = { readOnlyHint: true, destructiveHint: false } as const\n",
        "server/mcp/tools/a.ts":
          "import { defineMcpTool } from 'nitro-mcp-toolkit'\nimport { readOnly } from '../../utils/annotations'\nexport default defineMcpTool({ name: 'a', annotations: { ...readOnly, title: 'A' }, handler: () => 1 })\n",
        "server/mcp/tools/b.ts":
          "import { defineMcpTool } from 'nitro-mcp-toolkit'\nimport { readOnly } from '../../utils/annotations'\nexport default defineMcpTool({ name: 'b', annotations: readOnly, handler: () => 1 })\n",
      }),
    ).toEqual(["MCP0001 server/mcp/tools/b.ts"]);
  });

  test("stays silent when the annotations can't be resolved", async () => {
    expect(
      await codes({
        "server/mcp/tools/a.ts": tool(
          "{ name: 'a', annotations: { ...annotationsFor('a') }, handler: () => 1 }",
        ),
        "server/mcp/tools/b.ts":
          "import { defineMcpTool } from 'nitro-mcp-toolkit'\nimport { shared } from 'some-package'\nexport default defineMcpTool({ name: 'b', annotations: shared, handler: () => 1 })\n",
      }),
    ).toEqual([]);
  });

  test("reads Nuxt auto-imports and file-derived titles like the Quiver portal", async () => {
    const found = await messages(
      {
        "server/utils/mcp/toolAnnotations.ts":
          "export const readOnlyMcpToolAnnotations = {\n  readOnlyHint: true,\n  destructiveHint: false,\n  idempotentHint: true,\n  openWorldHint: false,\n} as const\n",
        "server/mcp/tools/get-kpis.ts":
          "export default defineMcpTool({\n  description: 'KPIs',\n  annotations: readOnlyMcpToolAnnotations,\n  handler: () => [],\n})\n",
        "server/mcp/tools/get-products.ts":
          "export default defineMcpTool({\n  name: 'search_products',\n  title: 'Search products',\n  annotations: { ...readOnlyMcpToolAnnotations, title: 'Search products' },\n  handler: () => [],\n})\n",
      },
      nuxtToolkit,
    );
    expect(found.map((diagnostic) => [diagnostic.code, relativePath(diagnostic.file)])).toEqual([
      ["MCP0001", "server/mcp/tools/get-kpis.ts"],
    ]);
    expect(found[0]?.message).toContain('"get-kpis"');
    expect(found[0]?.message).toContain('top-level title "Get Kpis" comes from the file name');
    expect(found[0]?.evidence?.[0]?.summary).toContain(
      "readOnlyMcpToolAnnotations (server/utils/mcp/toolAnnotations.ts)",
    );
  });

  test("ignores an unbound defineMcpTool when the Nuxt toolkit isn't installed", async () => {
    expect(
      await codes({
        "server/mcp/tools/a.ts": "export default defineMcpTool({ name: 'a', handler: () => 1 })\n",
      }),
    ).toEqual([]);
  });

  test("ignores a local function that happens to be called defineTool", async () => {
    expect(
      await codes({
        "src/tools.ts":
          "function defineTool(options: object) { return options }\nexport const a = defineTool({ name: 'a', handler: () => 1 })\n",
      }),
    ).toEqual([]);
  });

  test("reads h3-mcp, okmcp, and SDK registerTool definitions", async () => {
    expect(
      await codes(
        {
          "server/routes/mcp.ts":
            "import { defineMcpHandler, defineTool } from 'h3-mcp'\nconst hello = defineTool({ name: 'hello', handler: () => ({ content: [] }) })\nexport default defineMcpHandler({ name: 's', version: '1', tools: [hello] })\n",
          "server/routes/ok.ts":
            "import { defineTool } from 'okmcp'\nexport const ok = defineTool({ name: 'ok', annotations: { title: 'Ok', readOnlyHint: true }, handler: () => ({ content: [] }) })\n",
          "src/sdk.ts":
            "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'\nconst server = new McpServer({ name: 's', version: '1' })\nserver.registerTool('echo', { title: 'Echo', annotations: { readOnlyHint: true } }, async () => ({ content: [] }))\n",
        },
        { "h3-mcp": "^0.2.0", okmcp: "^0.3.0", "@modelcontextprotocol/sdk": "^1.32.0" },
      ),
    ).toEqual([
      "MCP0001 server/routes/mcp.ts",
      "MCP0001 src/sdk.ts",
      "MCP0002 server/routes/mcp.ts",
    ]);
  });
});

describe("MCP tool names", () => {
  test("reports long names and names with other characters", async () => {
    const annotations = "annotations: { title: 'T', readOnlyHint: true }";
    expect(
      await codes({
        "server/mcp/tools/a.ts": tool(
          `{ name: '${"x".repeat(65)}', ${annotations}, handler: () => 1 }`,
        ),
        "server/mcp/tools/b.ts": tool(`{ name: 'list orders', ${annotations}, handler: () => 1 }`),
        "server/mcp/tools/c.ts": tool(
          `{ name: 'admin.tools.list', ${annotations}, handler: () => 1 }`,
        ),
        "server/mcp/tools/d.ts": tool(
          `{ name: '${"y".repeat(64)}', ${annotations}, handler: () => 1 }`,
        ),
      }),
    ).toEqual(["MCP0003 server/mcp/tools/a.ts", "MCP0003 server/mcp/tools/b.ts"]);
  });

  test("checks file-derived names from the Nuxt toolkit", async () => {
    const found = await messages(
      {
        "server/mcp/tools/orders+refunds.ts":
          "export default defineMcpTool({ annotations: { title: 'List orders', readOnlyHint: true }, handler: () => [] })\n",
      },
      nuxtToolkit,
    );
    expect(found.map((diagnostic) => diagnostic.code)).toEqual(["MCP0003"]);
    expect(found[0]?.message).toContain("comes from the file name");
  });
});

describe("MCP Rule Pack", () => {
  test("activates on MCP server libraries with every Rule recommended", () => {
    expect(mcpRulePack.name).toBe("vite-doctor/mcp");
    expect(mcpRulePack.activation).toEqual({
      packages: [
        "h3-mcp",
        "okmcp",
        "nitro-mcp-toolkit",
        "@nuxtjs/mcp-toolkit",
        "@modelcontextprotocol/sdk",
        "@modelcontextprotocol/server",
      ],
    });
    expect(mcpRulePack.presets.recommended).toEqual(rules.map((rule) => rule.meta.id));
  });

  test("runs through the Vite Doctor distribution only for MCP projects", async () => {
    const files = {
      "server/mcp/tools/publish.ts": tool("{ name: 'publish', handler: () => 'ok' }"),
    };
    const mcpCodes = (result: { diagnostics: Array<{ code: string }> }) =>
      result.diagnostics
        .map((diagnostic) => diagnostic.code)
        .filter((code) => code.startsWith("MCP"))
        .sort();
    await withProject(nitroToolkit, files, async (root) => {
      expect(mcpCodes(await runViteDoctor({ root, framework: "vite", cache: false }))).toEqual([
        "MCP0001",
        "MCP0002",
      ]);
    });
    await withProject({ h3: "^2.0.0" }, files, async (root) => {
      expect(mcpCodes(await runViteDoctor({ root, framework: "vite", cache: false }))).toEqual([]);
    });
  });
});

function relativePath(file: string) {
  return file.slice(file.search(/(?:server|src)\//));
}

async function withProject(
  dependencies: Record<string, string>,
  files: Record<string, string>,
  run: (root: string) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "vite-doctor-mcp-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", dependencies }));
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
