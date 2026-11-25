import { describe, expect, test } from "vite-plus/test";
import {
  checkMcpToolList,
  mcpClientRules,
  type CheckMcpToolListOptions,
  type McpTool,
  type McpToolList,
} from "../../src/mcp/index.ts";

const object = (properties: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  type: "object",
  properties,
  ...extra,
});
const tool = (fields: Partial<McpTool> = {}): McpTool => ({
  name: "search",
  description: "Search the docs.",
  inputSchema: object(),
  ...fields,
});
const named = (length: number) => tool({ name: "t".repeat(length) });
const schema = (inputSchema: Record<string, unknown>) => tool({ inputSchema });
const tools = (count: number) =>
  Array.from({ length: count }, (_, index) => tool({ name: `tool_${index}` }));

interface Case {
  fail: McpTool | McpToolList;
  pass: McpTool | McpToolList;
  options?: CheckMcpToolListOptions;
}

const cases: Record<string, Case> = {
  "claude-code/tool-name-length": { fail: named(121), pass: named(120) },
  "claude-code/property-name": {
    fail: schema(object({ "page size": { type: "integer" } })),
    pass: schema(object({ "page_size.v-1": { type: "integer" } })),
  },
  "claude-code/schema-draft-2020-12": {
    fail: schema(object({ pair: { type: "array", items: [{ type: "string" }] } })),
    pass: schema(object({ pair: { type: "array", prefixItems: [{ type: "string" }] } })),
  },
  "claude-code/root-combinator": {
    fail: schema(object({}, { anyOf: [{ required: ["a"] }, { required: ["b"] }] })),
    pass: schema(object({ a: { anyOf: [{ type: "string" }, { type: "number" }] } })),
  },
  "claude-code/description-length": {
    fail: tool({ description: "d".repeat(4_097) }),
    pass: tool({ description: "d".repeat(4_096) }),
  },
  "claude-code/instructions-length": {
    fail: { initialize: { instructions: "i".repeat(4_097) }, tools: [tool()] },
    pass: { initialize: { instructions: "i".repeat(4_096) }, tools: [tool()] },
  },
  "claude-code/missing-instructions": {
    fail: { initialize: { serverInfo: { name: "docs" } }, tools: [tool()] },
    pass: { initialize: { instructions: "Search the docs." }, tools: [tool()] },
  },
  "claude-directory/tool-name-length": { fail: named(65), pass: named(64) },
  "claude-directory/missing-title": {
    fail: tool(),
    pass: tool({ annotations: { title: "Search docs" } }),
  },
  "claude-directory/missing-hint": {
    fail: tool({ annotations: { readOnlyHint: false, destructiveHint: false } }),
    pass: tool({ annotations: { destructiveHint: true } }),
  },
  "chatgpt/missing-read-only-hint": {
    fail: tool({ annotations: { destructiveHint: false } }),
    pass: tool({ annotations: { readOnlyHint: true } }),
  },
  "codex/schema-size": {
    fail: schema(
      object(
        Object.fromEntries(
          Array.from({ length: 50 }, (_, index) => [
            `field_${index}`,
            { type: "string", description: "x".repeat(100) },
          ]),
        ),
      ),
    ),
    pass: schema(object({ query: { type: "string", description: "x".repeat(100) } })),
  },
  "codex/dropped-constraints": {
    fail: schema(object({ limit: { type: "integer", maximum: 100 } })),
    pass: schema(object({ limit: { type: "integer", maximum: 100, description: "At most 100." } })),
  },
  "codex/name-characters": {
    fail: tool({ name: "search.docs" }),
    pass: tool({ name: "search_docs" }),
  },
  "codex/name-length": { fail: named(126), pass: named(125) },
  "cursor/name-length": { fail: named(60), pass: named(59) },
  "vscode/schema-draft-07": {
    fail: schema(object({}, { required: "query" })),
    pass: schema(object({ query: { type: "string" } }, { required: ["query"] })),
  },
  "vscode/root-combinator": {
    fail: schema(object({}, { not: { required: ["a"] } })),
    pass: schema(object({ a: { not: { type: "null" } } })),
  },
  "vscode/missing-description": {
    fail: tool({ description: undefined }),
    pass: tool(),
  },
  "vscode/tool-count": { fail: { tools: tools(129) }, pass: { tools: tools(128) } },
  "vscode/array-without-items": {
    fail: schema(object({ tags: { type: "array" } })),
    pass: schema(object({ tags: { type: "array", items: { type: "string" } } })),
  },
  "vscode/gpt-4-description-length": {
    fail: schema(object({ query: { type: "string", description: "d".repeat(1_025) } })),
    pass: schema(object({ query: { type: "string", description: "d".repeat(1_024) } })),
  },
  "vscode/gpt-4-dropped-constraints": {
    fail: schema(object({ query: { type: "string", maxLength: 200 } })),
    pass: schema(
      object({ query: { type: "string", maxLength: 200, description: "Up to 200 characters." } }),
    ),
  },
  "vscode/name-characters": {
    fail: tool({ name: "search.docs" }),
    pass: tool({ name: "search-docs" }),
  },
  "vscode/name-length": { fail: named(59), pass: named(58) },
  "gemini-cli/name-characters": {
    fail: tool({ name: "search/docs" }),
    pass: tool({ name: "search.docs:v1" }),
  },
  "gemini-cli/name-length": { fail: named(58), pass: named(57) },
  "copilot-studio/numeric-exclusive-minimum": {
    fail: schema(object({ count: { type: "integer", exclusiveMinimum: 0 } })),
    pass: schema(object({ count: { type: "number", exclusiveMinimum: 0.5 } })),
  },
  "copilot-studio/reference": {
    fail: schema(
      object({ filter: { $ref: "#/$defs/filter" } }, { $defs: { filter: { type: "string" } } }),
    ),
    pass: schema(object({ filter: { type: "string" } })),
  },
  "copilot-studio/type-array": {
    fail: schema(object({ cursor: { type: ["string", "null"] } })),
    pass: schema(object({ cursor: { type: "string" } })),
  },
  "copilot-studio/enum-as-string": {
    fail: schema(object({ sort: { type: "string", enum: ["asc", "desc"] } })),
    pass: schema(object({ sort: { type: "string" } })),
  },
};

function hits(rule: string, input: McpTool | McpToolList, options: CheckMcpToolListOptions = {}) {
  const client = mcpClientRules.find((candidate) => candidate.rule === rule)!.client;
  const list = "tools" in input && Array.isArray(input.tools) ? input : [input];
  return checkMcpToolList(list, { clients: [client], ...options }).filter(
    (finding) => finding.rule === rule,
  );
}

describe("tools/list rules", () => {
  test("every tool and server rule has a failing and a passing case", () => {
    const listRules = mcpClientRules.filter((rule) => rule.scope !== "result").map((r) => r.rule);
    expect(Object.keys(cases).sort()).toEqual(listRules.sort());
  });

  for (const [rule, { fail, pass, options }] of Object.entries(cases)) {
    test(rule, () => {
      const found = hits(rule, fail, options);
      expect(found.length).toBeGreaterThan(0);
      const definition = mcpClientRules.find((candidate) => candidate.rule === rule)!;
      for (const finding of found) {
        expect(finding).toMatchObject({
          client: definition.client,
          effect: definition.effect,
          severity: definition.severity,
          source: definition.source,
        });
        expect(finding.message).toBeTruthy();
        expect(finding.fix).toBeTruthy();
        expect("tool" in finding).toBe(definition.scope === "tool");
      }
      expect(hits(rule, pass, options)).toEqual([]);
    });
  }
});

describe("rule sources", () => {
  test("every rule cites an https source with an ISO date and a verbatim quote", () => {
    for (const rule of mcpClientRules) {
      expect(rule.source.url, rule.rule).toMatch(/^https:\/\//);
      expect(rule.source.checked, rule.rule).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(rule.source.checked).toISOString().slice(0, 10)).toBe(rule.source.checked);
      expect(rule.source.quote.trim(), rule.rule).not.toBe("");
      expect(rule.rule.startsWith(`${rule.client}/`), rule.rule).toBe(true);
    }
  });

  test("rule ids are unique", () => {
    const ids = mcpClientRules.map((rule) => rule.rule);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("forum sources lower the confidence", () => {
    for (const rule of mcpClientRules.filter((candidate) => candidate.source.kind === "forum"))
      expect(rule.confidence, rule.rule).toBe("medium");
  });
});

describe("rule details", () => {
  test("name lengths count the configured server name", () => {
    expect(
      hits("claude-code/tool-name-length", named(110), { serverName: "s".repeat(11) }),
    ).toEqual([]);
    const [finding] = hits("claude-code/tool-name-length", named(110), {
      serverName: "s".repeat(12),
    });
    expect(finding?.measured).toEqual({ value: 129, limit: 128, unit: "characters" });
    expect(finding?.message).not.toContain("one-character");
    expect(hits("claude-code/tool-name-length", named(121))[0]?.message).toContain(
      "even with a one-character server name",
    );
  });

  test("Claude Code skips the 2020-12 check for schemas declaring another dialect", () => {
    const draft07 = schema(
      object(
        { pair: { type: "array", items: [{ type: "string" }] } },
        { $schema: "http://json-schema.org/draft-07/schema#" },
      ),
    );
    expect(hits("claude-code/schema-draft-2020-12", draft07)).toEqual([]);
  });

  test("Claude Code reports every invalid top-level property name", () => {
    const found = hits(
      "claude-code/property-name",
      schema(object({ "a b": {}, "c/d": {}, ["x".repeat(65)]: {}, ok: {} })),
    );
    expect(found.map((finding) => finding.pointer)).toEqual([
      "/inputSchema/properties/a b",
      "/inputSchema/properties/c~1d",
      `/inputSchema/properties/${"x".repeat(65)}`,
    ]);
  });

  test("missing instructions needs the initialize result", () => {
    expect(hits("claude-code/missing-instructions", tool())).toEqual([]);
  });

  test("Codex lists the compaction passes it runs", () => {
    const [finding] = hits("codex/schema-size", cases["codex/schema-size"]!.fail);
    expect(finding?.message).toContain("strips every description");
    expect(finding?.measured?.unit).toBe("bytes");
    expect(finding?.measured?.value).toBeGreaterThan(5_000);
  });

  test("Codex ignores constraint values a description states", () => {
    const tool_ = tool({
      description: "Search the docs. Returns between 1 and 50 results.",
      inputSchema: object({ limit: { type: "integer", minimum: 1, maximum: 50, default: 10 } }),
    });
    const [finding] = hits("codex/dropped-constraints", tool_);
    expect(finding?.pointer).toBe("/inputSchema/properties/limit/default");
    expect(finding?.message).toContain("`default`");
    expect(finding?.message).not.toContain("`maximum`");
  });

  test("dropped constraints skip Zod's safe-integer bounds", () => {
    const zod = tool({
      inputSchema: object({
        offset: {
          type: "integer",
          minimum: Number.MIN_SAFE_INTEGER,
          maximum: Number.MAX_SAFE_INTEGER,
        },
      }),
    });
    expect(hits("codex/dropped-constraints", zod)).toEqual([]);
    expect(hits("vscode/gpt-4-dropped-constraints", zod)).toEqual([]);
    const number = tool({
      inputSchema: object({ ratio: { type: "number", maximum: Number.MAX_SAFE_INTEGER } }),
    });
    expect(hits("codex/dropped-constraints", number)).toHaveLength(1);
  });

  test("Codex keywords count only descriptions that survive compaction", () => {
    const big = cases["codex/schema-size"]!.fail as McpTool;
    const described = {
      ...big,
      inputSchema: object({
        ...(big.inputSchema!.properties as object),
        limit: { type: "integer", maximum: 100, description: "At most 100." },
      }),
    };
    expect(hits("codex/dropped-constraints", described)).toHaveLength(1);
  });

  test.each(["codex/dropped-constraints", "vscode/gpt-4-dropped-constraints"])(
    "%s skips only true defaults stated correctly",
    (rule) => {
      const withDescription = (description: string) =>
        schema(object({ enabled: { type: "boolean", default: true, description } }));
      for (const description of [
        "Defaults to true.",
        "The default is true.",
        "Return less (default: true).",
        "default: `true`",
        "Enabled true by default.",
      ])
        expect(hits(rule, withDescription(description)), description).toEqual([]);
      for (const description of ["Enable the feature.", "Defaults to false.", "true or false"]) {
        expect(hits(rule, withDescription(description))[0]?.pointer, description).toBe(
          "/inputSchema/properties/enabled/default",
        );
      }
    },
  );

  test.each(["codex/dropped-constraints", "vscode/gpt-4-dropped-constraints"])(
    "%s counts a string default only where the prose declares it",
    (rule) => {
      const withDescription = (description: string) =>
        schema(object({ order: { type: "string", default: "desc", description } }));
      for (const description of [
        "Sort order. Defaults to desc.",
        "Sort order (default: `desc`).",
        "Sort order, asc or desc (default desc).",
        'Sort order: "asc" or "desc" (default).',
        "Newest first or not (default: desc).",
      ])
        expect(hits(rule, withDescription(description)), description).toEqual([]);
      for (const description of [
        "Sort order (ascending or descending).",
        "Sort order: asc or desc.",
      ])
        expect(hits(rule, withDescription(description)), description).toHaveLength(1);
    },
  );

  test.each(["codex/dropped-constraints", "vscode/gpt-4-dropped-constraints"])(
    "%s skips empty defaults and minimums of 1",
    (rule) => {
      const implied = object({
        a: { type: ["string", "null"], default: null },
        b: { type: "boolean", default: false },
        c: { type: "string", default: "", minLength: 1 },
        d: { type: "array", items: { type: "string" }, default: [], minItems: 1 },
        e: { type: "object", default: {}, minProperties: 0 },
      });
      expect(hits(rule, schema(implied))).toEqual([]);
      const strict = object({
        a: { type: "integer", default: 0 },
        b: { type: "string", minLength: 2 },
        c: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 1 },
      });
      expect(hits(rule, schema(strict))[0]?.affectedPointers).toEqual([
        "/inputSchema/properties/a/default",
        "/inputSchema/properties/b/minLength",
        // Codex keeps `minItems`.
        ...(rule.startsWith("vscode") ? ["/inputSchema/properties/c/minItems"] : []),
        "/inputSchema/properties/c/maxItems",
      ]);
    },
  );

  test.each(["codex/dropped-constraints", "vscode/gpt-4-dropped-constraints"])(
    "%s matches array and object defaults ignoring spaces and quote style",
    (rule) => {
      const withDescription = (value: unknown, description: string) =>
        schema(
          object({
            v: {
              type: typeof value === "object" && !Array.isArray(value) ? "object" : "array",
              default: value,
              description,
            },
          }),
        );
      expect(
        hits(rule, withDescription(["model", "dataset"], 'Defaults to ["model", "dataset"].')),
      ).toEqual([]);
      expect(hits(rule, withDescription(["a", "b"], "Defaults to [ 'a', 'b' ]."))).toEqual([]);
      expect(hits(rule, withDescription({ sort: "asc" }, "Defaults to {'sort': 'asc'}."))).toEqual(
        [],
      );
      expect(hits(rule, withDescription(["a", "b"], "Defaults to ['b', 'a']."))).toHaveLength(1);
      expect(hits(rule, withDescription(["New York"], 'Defaults to ["NewYork"].'))).toHaveLength(1);
      expect(
        hits(rule, withDescription(["Bob's project"], `Defaults to ['Bob"s project'].`)),
      ).toHaveLength(1);
      expect(
        hits(rule, withDescription(["Bob's project"], String.raw`Defaults to ['Bob\'s project'].`)),
      ).toEqual([]);
      expect(
        hits(
          rule,
          withDescription(
            { city: "New York", tags: ["]"] },
            `Default: {"tags": [']'], 'city': "New York"}.`,
          ),
        ),
      ).toEqual([]);
    },
  );

  test.each(["codex/dropped-constraints", "vscode/gpt-4-dropped-constraints"])(
    "%s counts a strict date pattern described as YYYY-MM-DD",
    (rule) => {
      const withPattern = (pattern: string, description = "First date, formatted YYYY-MM-DD.") =>
        schema(object({ from: { type: "string", pattern, description } }));
      for (const date of [
        // Zod 4's `z.iso.date()`.
        String.raw`^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))$`,
        String.raw`^\d{4}-\d{2}-\d{2}$`,
      ]) {
        expect(hits(rule, withPattern(date)), date).toEqual([]);
        expect(hits(rule, withPattern(date, "First date.")), date).toHaveLength(1);
      }
      for (const other of [
        "^\\d{4}-\\d{1,2}-\\d{1,2}$",
        "\\d{4}-\\d{2}-\\d{2}",
        "[",
        String.raw`^(?:19\d{2}|20[0-2]\d)-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$`,
        String.raw`^\d{4}-(?:0[1-24-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$`,
      ])
        expect(hits(rule, withPattern(other)), other).toHaveLength(1);
    },
  );

  test("VS Code checks gpt-4 constraints only along the paths its normalizer walks", () => {
    const defs = schema(object({}, { $defs: { q: { type: "string", maxLength: 3 } } }));
    expect(hits("vscode/gpt-4-dropped-constraints", defs)).toEqual([]);
    const nested = schema(
      object({ q: { type: "array", items: { type: "string", maxLength: 3 } } }),
    );
    expect(hits("vscode/gpt-4-dropped-constraints", nested)[0]?.pointer).toBe(
      "/inputSchema/properties/q/items/maxLength",
    );
  });

  test("VS Code builds the tool id from the announced server name", () => {
    const list = {
      initialize: { serverInfo: { name: "Context7", title: "Context 7 Docs" } },
      tools: [named(50)],
    };
    const [finding] = hits("vscode/name-length", list);
    expect(finding?.message).toContain("`mcp_context_7_doc_");
    expect(finding?.measured?.value).toBe(4 + 13 + 1 + 50);
  });

  test("VS Code array check reaches nested and combinator branches", () => {
    const found = hits(
      "vscode/array-without-items",
      schema(
        object({
          a: { anyOf: [{ type: "array" }, { type: "string" }] },
          b: { type: "object", properties: { c: { type: "array" } } },
        }),
      ),
    );
    expect(found[0]?.message).toContain("`/inputSchema/properties/a/anyOf/0`");
    expect(found[0]?.message).toContain("`/inputSchema/properties/b/properties/c`");
    expect(found[0]?.confidence).toBe("medium");
  });

  test("VS Code checks schema-valued draft-07 dependencies", () => {
    const found = hits(
      "vscode/array-without-items",
      schema({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        dependencies: {
          flags: ["enabled"],
          search: object({ tags: { type: "array" } }),
        },
      }),
    );
    expect(found.map((finding) => finding.pointer)).toEqual([
      "/inputSchema/dependencies/search/properties/tags",
    ]);
  });

  test("Gemini CLI shows the cut name", () => {
    const [finding] = hits(
      "gemini-cli/name-length",
      tool({ name: "a".repeat(40) + "z".repeat(30) }),
      {
        serverName: "docs",
      },
    );
    expect(finding?.message).toContain(`\`mcp_docs_${"a".repeat(21)}...${"z".repeat(30)}\``);
  });

  test("Copilot Studio reports one finding per tool listing every pointer", () => {
    const found = hits(
      "copilot-studio/enum-as-string",
      schema(object({ a: { enum: ["x"] }, b: { items: { enum: ["y"] } } })),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("`/inputSchema/properties/b/items/enum`");
  });
});

test("the Directory title check reads annotations.title, not the top-level title", () => {
  const rules = (fields: Partial<McpTool>) =>
    checkMcpToolList({ tools: [tool(fields)] }).map((finding) => finding.rule);
  expect(rules({ title: "Search docs" })).toContain("claude-directory/missing-title");
  expect(rules({ annotations: { title: "Search docs" } })).not.toContain(
    "claude-directory/missing-title",
  );
});

test("ChatGPT's readOnlyHint check skips a tool that declares itself destructive", () => {
  const rules = (fields: Partial<McpTool>) =>
    checkMcpToolList({ tools: [tool(fields)] }).map((finding) => finding.rule);
  expect(rules({ annotations: { destructiveHint: true } })).not.toContain(
    "chatgpt/missing-read-only-hint",
  );
  expect(rules({ annotations: {} })).toContain("chatgpt/missing-read-only-hint");
});
