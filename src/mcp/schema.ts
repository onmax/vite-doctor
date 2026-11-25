import type { McpJsonSchema } from "./types.js";

const SCHEMA_MAPS = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies",
];
const SCHEMA_LISTS = ["anyOf", "oneOf", "allOf", "prefixItems"];
const SCHEMA_VALUES = [
  "items",
  "additionalProperties",
  "unevaluatedProperties",
  "additionalItems",
  "unevaluatedItems",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
];

export interface SchemaNode {
  schema: McpJsonSchema;
  /** JSON Pointer from the schema root, such as `/properties/limit`. */
  pointer: string;
  /** Property names from the root, for messages, such as `filters.limit`. */
  label: string;
}

/** Every subschema of `root`, root first, without following `$ref`. */
export function* walkSchema(root: unknown): Generator<SchemaNode> {
  if (!isSchema(root)) return;
  const stack: SchemaNode[] = [{ schema: root, pointer: "", label: "" }];
  while (stack.length) {
    const node = stack.pop()!;
    yield node;
    const children: SchemaNode[] = [];
    for (const keyword of SCHEMA_MAPS) {
      const map = node.schema[keyword];
      if (!isSchema(map)) continue;
      for (const [key, child] of Object.entries(map)) {
        if (!isSchema(child)) continue;
        const property = keyword === "properties";
        children.push({
          schema: child,
          pointer: `${node.pointer}/${keyword}/${escapePointer(key)}`,
          label: property ? join(node.label, key) : node.label,
        });
      }
    }
    for (const keyword of SCHEMA_LISTS) {
      const list = node.schema[keyword];
      if (!Array.isArray(list)) continue;
      list.forEach((child, index) => {
        if (isSchema(child))
          children.push({
            schema: child,
            pointer: `${node.pointer}/${keyword}/${index}`,
            label: node.label,
          });
      });
    }
    for (const keyword of SCHEMA_VALUES) {
      const value = node.schema[keyword];
      if (Array.isArray(value) && keyword === "items")
        value.forEach((child, index) => {
          if (isSchema(child))
            children.push({
              schema: child,
              pointer: `${node.pointer}/items/${index}`,
              label: join(node.label, "[]"),
            });
        });
      else if (isSchema(value))
        children.push({
          schema: value,
          pointer: `${node.pointer}/${keyword}`,
          label: keyword === "items" ? join(node.label, "[]") : node.label,
        });
    }
    stack.push(...children.reverse());
  }
}

export function isSchema(value: unknown): value is McpJsonSchema {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapePointer(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}

function join(parent: string, key: string): string {
  if (key === "[]") return `${parent}[]`;
  return parent ? `${parent}.${key}` : key;
}
