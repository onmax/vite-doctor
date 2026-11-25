import { expect, test } from "vite-plus/test";
import { jsonBytes, reduceCodexInputSchema } from "../../src/mcp/codex-schema.ts";

const leaf = {
  type: "object",
  properties: { nested: { type: "object", properties: { leaf: { type: "string" } } } },
};

// collapse_deep_schema_objects_traverses_schema_children in compaction_tests.rs.
const deep = {
  type: "object",
  properties: {
    object_parent: {
      type: "object",
      properties: { complex: leaf, scalar: { type: "string" } },
    },
    array_parent: { type: "array", items: leaf },
    map_parent: { type: "object", additionalProperties: leaf },
    union_parent: { anyOf: [leaf, { type: "string" }] },
  },
};
const collapsed = { type: "object", properties: { nested: {} } };

test("collapses objects nested three levels deep, as Codex's own test expects", () => {
  // Codex's sanitize step, which runs first, also gives `map_parent` empty `properties`.
  const expected = {
    type: "object",
    properties: {
      object_parent: {
        type: "object",
        properties: { complex: collapsed, scalar: { type: "string" } },
      },
      array_parent: { type: "array", items: collapsed },
      map_parent: { type: "object", properties: {}, additionalProperties: collapsed },
      union_parent: { anyOf: [collapsed, { type: "string" }] },
    },
  };
  const reduction = reduceCodexInputSchema(deep, jsonBytes(expected));
  expect(reduction?.passes).toEqual([
    "strip-descriptions",
    "drop-definitions",
    "collapse-deep-objects",
  ]);
  expect(reduction?.compacted).toEqual(expected);
});

test("leaves a schema under the budget alone and adds missing properties", () => {
  const reduction = reduceCodexInputSchema({ type: "object" });
  expect(reduction).toEqual({
    schema: { type: "object", properties: {} },
    bytes: jsonBytes({ type: "object", properties: {} }),
    passes: [],
    compacted: { type: "object", properties: {} },
  });
});

test("keeps only the keywords Codex's subset knows", () => {
  const reduction = reduceCodexInputSchema({
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 50, description: "Max results." },
      query: { type: "string", pattern: "^a", format: "uri", minLength: 1 },
    },
    required: ["query"],
  });
  expect(reduction?.schema).toEqual({
    type: "object",
    properties: {
      limit: { type: "integer", description: "Max results." },
      query: { type: "string" },
    },
    required: ["query"],
  });
});

test("measures UTF-8 bytes of compact JSON", () => {
  expect(jsonBytes({ a: "é" })).toBe(10);
});

test("returns undefined for a schema that is not an object", () => {
  expect(reduceCodexInputSchema(undefined)).toBeUndefined();
  expect(reduceCodexInputSchema([])).toBeUndefined();
});
