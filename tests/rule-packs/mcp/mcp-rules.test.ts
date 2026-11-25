import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { describe, expect, test } from "vite-plus/test";
import { runViteDoctor } from "../../../src/doctor.ts";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import {
  mcpRulePack,
  noIndentedJsonOutput,
  requireAnnotationTitle,
  requireSafetyHint,
  validName,
} from "../../../src/rule-packs/mcp/index.ts";

const nitroToolkit = { "nitro-mcp-toolkit": "^0.4.0", h3: "^2.0.0" };
const nuxtToolkit = { "@nuxtjs/mcp-toolkit": "^0.24.0", nuxt: "^4.0.0" };
const viteHub = { "vite-hub": "^0.5.0", vite: "^8.0.0" };
const rules = [requireAnnotationTitle, requireSafetyHint, validName, noIndentedJsonOutput];

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

  test.each(["undefined", "false", "null", "123", "''", "'   '", "{}", "[]"])(
    "reports an unusable annotation title: %s",
    async (title) => {
      expect(
        await codes({
          "src/tool.ts": tool(
            `{ name: 'a', annotations: { title: ${title}, readOnlyHint: true }, handler: () => 1 }`,
          ),
        }),
      ).toEqual(["MCP0001 src/tool.ts"]);
    },
  );

  test.each(["false", "undefined", "null", "'true'", "1", "{}"])(
    "reports safety hints that are not true: %s",
    async (hint) => {
      expect(
        await codes({
          "src/read.ts": tool(
            `{ name: 'read', annotations: { title: 'Read', readOnlyHint: ${hint} }, handler: () => 1 }`,
          ),
          "src/write.ts": tool(
            `{ name: 'write', annotations: { title: 'Write', destructiveHint: ${hint} }, handler: () => 1 }`,
          ),
        }),
      ).toEqual(["MCP0002 src/read.ts", "MCP0002 src/write.ts"]);
    },
  );

  test("keeps unresolved annotation values conservative per rule", async () => {
    expect(
      await codes({
        "src/title.ts": tool(
          "{ name: 'title', annotations: { title: getTitle(), readOnlyHint: true }, handler: () => 1 }",
        ),
        "src/hint.ts": tool(
          "{ name: 'hint', annotations: { title: 'Hint', readOnlyHint: getHint(), destructiveHint: false }, handler: () => 1 }",
        ),
        "src/missing-title.ts": tool(
          "{ name: 'missing_title', annotations: { readOnlyHint: getHint() }, handler: () => 1 }",
        ),
      }),
    ).toEqual(["MCP0001 src/missing-title.ts"]);
  });

  test("uses final annotation values after local and imported spreads", async () => {
    expect(
      await codes({
        "src/annotations.ts":
          "export const title = 'A'\nexport const read = true\nexport const valid = { title, readOnlyHint: read, destructiveHint: false }\nexport const invalid = { title: undefined, readOnlyHint: false }\n",
        "src/valid.ts":
          "import { defineMcpTool } from 'nitro-mcp-toolkit'\nimport { valid, invalid } from './annotations'\nconst local = { ...invalid, ...valid } as const\nexport default defineMcpTool({ name: 'a', annotations: local, handler: () => 1 })\n",
        "src/invalid.ts":
          "import { defineMcpTool } from 'nitro-mcp-toolkit'\nimport { valid, invalid } from './annotations'\nexport default defineMcpTool({ name: 'b', annotations: { ...valid, ...invalid }, handler: () => 1 })\n",
      }),
    ).toEqual(["MCP0001 src/invalid.ts", "MCP0002 src/invalid.ts"]);
  });

  test.each([
    ["module constants", "const title = ''; const hint = false; const annotations = {}"],
    ["imports", "import { title, hint, annotations } from './values'"],
    ["auto-imports", ""],
  ])("does not resolve parameters through same-named %s", async (_label, declarations) => {
    expect(
      await codes({
        "src/values.ts":
          "export const title = ''; export const hint = false; export const annotations = {}",
        "server/utils/values.ts":
          "export const title = ''; export const hint = false; export const annotations = {}",
        "src/tool.ts": `
import { defineMcpTool } from 'nitro-mcp-toolkit'
${declarations}
function register(title, hint, annotations) {
  defineMcpTool({ name: 'values', annotations: { title, readOnlyHint: hint } })
  defineMcpTool({ name: 'object', annotations })
  defineMcpTool({ name: 'spread', annotations: { ...annotations } })
}
`,
      }),
    ).toEqual([]);
  });

  test.each(["{ title, readOnlyHint: hint }", "annotations", "{ ...annotations }"])(
    "reads shadowing block-local constants in %s",
    async (annotations) => {
      for (const valid of [true, false]) {
        expect(
          await codes({
            "src/tool.ts": `
import { defineMcpTool } from 'nitro-mcp-toolkit'
const title = ${valid ? "''" : "'Outer'"}
const hint = ${!valid}
const annotations = { title, readOnlyHint: hint }
{
  const title = ${valid ? "'Inner'" : "''"}
  const hint = ${valid}
  const annotations = { title, readOnlyHint: hint }
  defineMcpTool({ name: 'local', annotations: ${annotations} })
}
`,
          }),
        ).toEqual(valid ? [] : ["MCP0001 src/tool.ts", "MCP0002 src/tool.ts"]);
      }
    },
  );

  test.each([
    "let title = getTitle(); let hint = getHint()",
    "const { title, hint } = getAnnotations()",
  ])("keeps unreadable local bindings unknown: %s", async (declarations) => {
    expect(
      await codes({
        "src/tool.ts": `
import { defineMcpTool } from 'nitro-mcp-toolkit'
const title = ''; const hint = false
{
  ${declarations}
  defineMcpTool({ name: 'local', annotations: { title, readOnlyHint: hint } })
}
`,
      }),
    ).toEqual([]);
  });

  test("does not treat a shadowed undefined parameter as the global value", async () => {
    expect(
      await codes({
        "src/tool.ts": `
import { defineMcpTool } from 'nitro-mcp-toolkit'
function register(undefined) {
  defineMcpTool({ name: 'title', annotations: { title: undefined, readOnlyHint: true } })
  defineMcpTool({ name: 'hint', annotations: { title: 'Hint', readOnlyHint: undefined } })
}
`,
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

  test.each(["@modelcontextprotocol/sdk/server/mcp.js", "@modelcontextprotocol/server"])(
    "requires SDK receiver binding evidence for %s",
    async (source) => {
      expect(
        await codes(
          {
            "src/sdk.ts": `
import { McpServer as Server, OtherServer } from '${source}'
const server = new Server({ name: 's', version: '1' })
server.registerTool('valid_sdk', {}, async () => ({}))
const unrelated = { registerTool() {} }
unrelated.registerTool('not an MCP tool', {}, () => ({}))
server.unrelated.registerTool('nested unrelated receiver', {}, () => ({}))
function shadowReceiver(server) {
  server.registerTool('also unrelated', {}, () => ({}))
}
function shadowConstructor(Server) {
  const local = new Server()
  local.registerTool('local constructor', {}, () => ({}))
}
const other = new OtherServer()
other.registerTool('other constructor', {}, () => ({}))
let mutable = new Server({ name: 's', version: '1' })
mutable = unrelated
mutable.registerTool('reassigned receiver', {}, () => ({}))
`,
          },
          { "@modelcontextprotocol/sdk": "^1.32.0", "@modelcontextprotocol/server": "^2.0.0" },
        ),
      ).toEqual(["MCP0001 src/sdk.ts", "MCP0002 src/sdk.ts"]);
    },
  );
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

describe("ViteHub MCP tools", () => {
  test("uses the discovered name in JSX and TSX files instead of an options override", async () => {
    const longName = "a".repeat(65);
    const found = await messages(
      {
        "server/mcp/tools/rows.tsx": tool(
          "{ name: 'not a tool name', annotations: { title: 'Rows', readOnlyHint: true }, handler: () => { const view: unknown = <div />; return JSON.stringify(view, null, 2) } }",
          "vite-hub/mcp",
        ),
        [`server/mcp/tools/${longName}.jsx`]: tool(
          "{ name: 'reports', annotations: { title: 'Reports', readOnlyHint: true }, handler: () => <div /> }",
          "@vite-hub/mcp",
        ),
      },
      viteHub,
    );
    expect(found.map((diagnostic) => diagnostic.code).sort()).toEqual(["MCP0003", "MCP0004"]);
    const invalidName = found.find((diagnostic) => diagnostic.code === "MCP0003");
    expect(invalidName?.message).toContain(longName);
    expect(invalidName?.suggestion).toContain("Rename or move the tool file");
    expect(invalidName?.suggestion).not.toContain("set `name`");
    expect(found.find((diagnostic) => diagnostic.code === "MCP0004")?.message).toContain('"rows"');
  });

  test("names a tool after its path below mcp/tools and fills no title", async () => {
    const found = await messages(
      {
        "server/mcp/tools/add.ts":
          "import { defineMcpTool } from 'vite-hub/mcp'\nexport default defineMcpTool({ description: 'Add', handler: () => 1 })\n",
        "server/mcp/tools/orders/index.ts":
          "import { defineMcpTool } from '@vite-hub/mcp'\nexport default defineMcpTool({ title: 'Orders', annotations: { title: 'Orders', readOnlyHint: true }, handler: () => [] })\n",
        "server/mcp/tools/list orders.ts":
          "import { defineMcpTool } from 'vite-hub/mcp'\nexport default defineMcpTool({ annotations: { title: 'List', readOnlyHint: true }, handler: () => [] })\n",
      },
      viteHub,
    );
    expect(
      found.map((diagnostic) => `${diagnostic.code} ${relativePath(diagnostic.file)}`).sort(),
    ).toEqual([
      "MCP0001 server/mcp/tools/add.ts",
      "MCP0002 server/mcp/tools/add.ts",
      "MCP0003 server/mcp/tools/list orders.ts",
    ]);
    const title = found.find((diagnostic) => diagnostic.code === "MCP0001");
    expect(title?.message).toContain('"add"');
    expect(title?.message).not.toContain("top-level title");
    expect(found.find((diagnostic) => diagnostic.code === "MCP0003")?.message).toContain(
      '"list orders"',
    );
  });
});

describe("MCP tool output", () => {
  test("ignores JSON that does not reach the handler's text result", async () => {
    const info = "name: 'rows', annotations: { title: 'Rows', readOnlyHint: true }";
    const pretty = "JSON.stringify({ a: 1 }, null, 2)";
    expect(
      await codes({
        "src/metadata.ts": tool(`{ ${info}, description: ${pretty}, handler: () => 'ok' }`),
        "src/metadata-text.ts": tool(`{ ${info}, text: ${pretty}, handler: () => 'ok' }`),
        "src/callback.ts": tool(
          `{ ${info}, handler() { console.log([1].map(() => ${pretty})); return 'ok' } }`,
        ),
        "src/structured.ts": tool(
          `{ ${info}, handler: () => ({ structuredContent: { text: ${pretty} }, content: [{ type: 'text', text: '{}' }] }) }`,
        ),
        "src/nontext.ts": tool(
          `{ ${info}, handler: () => ({ content: [{ type: 'image', text: ${pretty} }] }) }`,
        ),
        "src/overridden.ts": tool(`{ ${info}, handler: () => ${pretty}, ...otherOptions }`),
      }),
    ).toEqual([]);
  });

  test("does not treat shadowed JSON bindings as the built-in", async () => {
    const info = "name: 'rows', annotations: { title: 'Rows', readOnlyHint: true }";
    expect(
      await codes({
        "src/format.ts": "export const JSON = { stringify: () => '{}' }",
        "src/import.ts":
          "import { JSON } from './format'\n" +
          tool(`{ ${info}, handler: () => JSON.stringify({}, null, 2) }`),
        "src/parameter.ts": tool(`{ ${info}, handler: (JSON) => JSON.stringify({}, null, 2) }`),
      }),
    ).toEqual([]);
  });

  test("preserves the replacer and points to the stringify in a same-file helper", async () => {
    const stringify = "JSON.stringify({ id: 1, label: 'Example' }, ['id'], 2)";
    const found = await messages({
      "src/rows.ts":
        `const format = () => ${stringify}\n` +
        tool(
          "{ name: 'rows', annotations: { title: 'Rows', readOnlyHint: true }, handler: () => format() }",
        ),
    });
    expect(found.map((diagnostic) => diagnostic.code)).toEqual(["MCP0004"]);
    expect(found[0]?.suggestion).toContain("keep the replacer");
    expect(found[0]?.evidence?.[0]?.range).toMatchObject({
      start: "const format = () => ".length,
      end: "const format = () => ".length + stringify.length,
    });
  });

  test("reports indented JSON that a tool returns as its text", async () => {
    expect(
      await codes({
        "src/text.ts": tool(
          "{ name: 'text', annotations: { title: 'Text', readOnlyHint: true }, handler: async () => ({ content: [{ type: 'text', text: JSON.stringify(await rows(), null, 2) }] }) }",
        ),
        "src/return.ts": tool(
          "{ name: 'ret', annotations: { title: 'Return', readOnlyHint: true }, async handler() { const value = await rows()\n return JSON.stringify(value, undefined, '\\t') } }",
        ),
        "src/arrow.ts": tool(
          "{ name: 'arrow', annotations: { title: 'Arrow', readOnlyHint: true }, handler: () => (JSON.stringify(rows(), null, 2) as string) }",
        ),
        "src/named.ts":
          "function render() { return { content: [{ type: 'text', text: format() }] } }\n" +
          "const format = () => JSON.stringify({}, null, 2)\n" +
          tool(
            "{ name: 'named', annotations: { title: 'Named', readOnlyHint: true }, handler: render }",
          ),
      }),
    ).toEqual([
      "MCP0004 src/arrow.ts",
      "MCP0004 src/named.ts",
      "MCP0004 src/return.ts",
      "MCP0004 src/text.ts",
    ]);
  });

  test("follows a helper the tool returns, like the Quiver portal before compact output", async () => {
    const found = await messages(
      {
        "server/utils/mcp/structuredResult.ts":
          "export function toMcpStructuredResult(value: unknown, legacy?: unknown) {\n  const text = legacy ?? value\n  return { content: [{ type: 'text', text: JSON.stringify(text, null, 2) ?? String(text) }], structuredContent: value }\n}\n",
        "server/utils/mcp/format.ts":
          "import { toMcpStructuredResult } from './structuredResult'\nexport const formatRows = (rows: unknown[]) => toMcpStructuredResult({ rows })\n",
        "server/mcp/tools/list-alerts.ts":
          "export default defineMcpTool({\n  name: 'list_alerts',\n  annotations: { title: 'List alerts', readOnlyHint: true },\n  handler: async () => {\n    const alerts = await loadAlerts()\n    return toMcpStructuredResult({ alerts })\n  },\n})\n",
        "server/mcp/tools/list-rows.ts":
          "import { formatRows } from '../../utils/mcp/format'\nexport default defineMcpTool({\n  name: 'list_rows',\n  annotations: { title: 'List rows', readOnlyHint: true },\n  handler: async () => formatRows(await loadRows()),\n})\n",
      },
      nuxtToolkit,
    );
    expect(
      found.map((diagnostic) => `${diagnostic.code} ${relativePath(diagnostic.file)}`).sort(),
    ).toEqual(["MCP0004 server/mcp/tools/list-alerts.ts", "MCP0004 server/mcp/tools/list-rows.ts"]);
    expect(found[0]?.message).toContain("server/utils/mcp/structuredResult.ts");
    expect(relativePath(found[0]?.evidence?.[0]?.file ?? "")).toBe(
      "server/utils/mcp/structuredResult.ts",
    );
  });

  test("reports the SDK handler argument of registerTool", async () => {
    expect(
      await codes(
        {
          "src/server.ts":
            "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'\nconst server = new McpServer({ name: 's', version: '1' })\nserver.registerTool('list', { annotations: { title: 'List', readOnlyHint: true } }, async () => ({ content: [{ type: 'text', text: JSON.stringify(await rows(), null, 2) }] }))\nserver.registerTool('compact', { text: JSON.stringify({}, null, 2), annotations: { title: 'Compact', readOnlyHint: true } }, () => ({ content: [{ type: 'text', text: '{}' }] }))\n",
        },
        { "@modelcontextprotocol/sdk": "^1.20.0" },
      ),
    ).toEqual(["MCP0004 src/server.ts"]);
  });

  test("does not follow reassigned handler or helper declarations", async () => {
    const pretty = "function render() { return JSON.stringify({ n: 1 }, null, 2) }\n";
    const reassign = "render = () => '{\"n\":1}'\n";
    const options = (handler: string) =>
      `{ name: 'rows', annotations: { title: 'Rows', readOnlyHint: true }, handler: ${handler} }`;
    expect(
      await codes({
        "src/handler.ts": pretty + reassign + tool(options("render")),
        "src/local.ts": pretty + reassign + tool(options("() => render()")),
        "src/imported.ts": "import { render } from './render'\n" + tool(options("render")),
        "src/render.ts": "export " + pretty + reassign,
        "src/stable.ts": pretty + tool(options("render")),
      }),
    ).toEqual(["MCP0004 src/stable.ts"]);
  });

  test("follows the runtime implementation of an overloaded helper", async () => {
    const render = [
      "function render(n: number): string",
      "function render(n: string): string",
      "function render(n: number | string) { return JSON.stringify({ n }, null, 2) }",
    ];
    const definition = tool(
      "{ name: 'rows', annotations: { title: 'Rows', readOnlyHint: true }, handler: () => render(1) }",
    );
    expect(
      await codes({
        "src/local.ts": [...render, definition].join("\n"),
        "src/imported.ts": "import { render } from './render'\n" + definition,
        "src/render.ts": render.map((line) => `export ${line}`).join("\n"),
        "src/reassigned.ts": [...render, "render = () => '{}'", definition].join("\n"),
        "src/ambient.ts": "declare function render(n: number): string\n" + definition,
      }),
    ).toEqual(["MCP0004 src/imported.ts", "MCP0004 src/local.ts"]);
  });

  test("traces only Nitro's imported toolResult envelope", async () => {
    const result =
      "{ content: [{ type: 'text', text: JSON.stringify({ n: 1 }, null, 2) }], structuredContent: { n: 1 } }";
    const options = (handler: string) =>
      `{ name: 'rows', annotations: { title: 'Rows', readOnlyHint: true }, outputSchema: { n: z.number() }, handler: ${handler} }`;
    expect(
      await codes({
        "src/envelope.ts":
          "import { toolResult as envelope } from 'nitro-mcp-toolkit'\n" +
          tool(options(`() => envelope(${result})`)),
        "src/unrelated.ts":
          "import { toolResult } from 'another-package'\n" +
          tool(options(`() => toolResult(${result})`)),
        "src/shadowed.ts":
          "import { toolResult } from 'nitro-mcp-toolkit'\n" +
          tool(options(`(toolResult) => toolResult(${result})`)),
      }),
    ).toEqual(["MCP0004 src/envelope.ts"]);
  });

  test.each([
    ["./render", { "src/render.js": "export const render = () => '{}'" }, []],
    ["./render.jsx", {}, ["MCP0004 src/tool.ts"]],
  ])("follows Vite helper resolution for %s", async (specifier, otherFiles, expected) => {
    expect(
      await codes(
        {
          ...otherFiles,
          "src/render.tsx": "export const render = () => JSON.stringify({ n: 1 }, null, 2)",
          "src/tool.ts":
            `import { render } from '${specifier}'\n` +
            tool(
              "{ name: 'rows', annotations: { title: 'Rows', readOnlyHint: true }, handler: () => render() }",
              "vite-hub/mcp",
            ),
        },
        viteHub,
      ),
    ).toEqual(expected);
  });

  test("accepts compact JSON, logs, and indents Doctor can't read", async () => {
    expect(
      await codes({
        "src/compact.ts": tool(
          "{ name: 'compact', annotations: { title: 'Compact', readOnlyHint: true }, handler: async () => { const value = await rows()\n console.log(JSON.stringify(value, null, 2))\n const pretty = JSON.stringify(value, null, 2)\n void pretty\n return { content: [{ type: 'text', text: JSON.stringify(value) }, { type: 'text', text: JSON.stringify(value, null, 0) }, { type: 'text', text: JSON.stringify(value, null, indent) }] } } }",
        ),
      }),
    ).toEqual([]);
  });
});

describe("MCP Rule Pack", () => {
  test("activates on MCP server libraries and recommends the source Rules and lost-tool client limits", () => {
    expect(mcpRulePack.name).toBe("vite-doctor/mcp");
    expect(mcpRulePack.activation).toEqual({ packages: expect.any(Array) });
    const { packages } = mcpRulePack.activation || {};
    expect(packages?.toSorted()).toEqual([
      "@modelcontextprotocol/sdk",
      "@modelcontextprotocol/server",
      "@nuxtjs/mcp-toolkit",
      "@vite-hub/mcp",
      "h3-mcp",
      "nitro-mcp-toolkit",
      "okmcp",
      "vite-hub",
    ]);
    expect(mcpRulePack.presets.recommended.toSorted()).toEqual(
      [
        ...rules.map((rule) => rule.meta.id),
        "mcp/clients/no-excluded-tool",
        "mcp/clients/no-truncated-text",
      ].toSorted(),
    );
    expect(mcpRulePack.presets.strict).toHaveLength(mcpRulePack.rules.length);
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
