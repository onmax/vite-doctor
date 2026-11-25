import { expect, test } from "vite-plus/test";
import { walkSchema } from "../../src/mcp/index.ts";

const nodes = (schema: unknown) =>
  [...walkSchema(schema)].map((node) => [node.pointer, node.label]);

test("walks every subschema root first with pointers and property labels", () => {
  expect(
    nodes({
      type: "object",
      properties: {
        filters: {
          type: "object",
          properties: { tags: { type: "array", items: { type: "string" } } },
        },
        mode: { anyOf: [{ const: "a" }, { const: "b" }] },
      },
      $defs: { cursor: { type: "string" } },
      not: { required: ["x"] },
    }),
  ).toEqual([
    ["", ""],
    ["/properties/filters", "filters"],
    ["/properties/filters/properties/tags", "filters.tags"],
    ["/properties/filters/properties/tags/items", "filters.tags[]"],
    ["/properties/mode", "mode"],
    ["/properties/mode/anyOf/0", "mode"],
    ["/properties/mode/anyOf/1", "mode"],
    ["/$defs/cursor", ""],
    ["/not", ""],
  ]);
});

test("escapes pointer tokens", () => {
  expect(nodes({ properties: { "a/b": {}, "c~d": {} } }).map(([pointer]) => pointer)).toEqual([
    "",
    "/properties/a~1b",
    "/properties/c~0d",
  ]);
});

test("walks tuple items and prefixItems", () => {
  expect(
    nodes({ items: [{ type: "string" }], prefixItems: [{ type: "number" }] }).map(([p]) => p),
  ).toEqual(["", "/prefixItems/0", "/items/0"]);
});

test("does not follow $ref or walk non-schemas", () => {
  expect(nodes({ $ref: "#", properties: { a: true, b: { $ref: "#" } } })).toEqual([
    ["", ""],
    ["/properties/b", "b"],
  ]);
  expect(nodes(true)).toEqual([]);
  expect(nodes([{}])).toEqual([]);
});
