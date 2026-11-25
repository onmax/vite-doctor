/**
 * Codex's reduction of an MCP tool's input schema to the JSON Schema subset it sends the model,
 * ported from codex-rs/tools/src/json_schema.rs, json_schema/types.rs, json_schema/traversal.rs,
 * json_schema/compaction.rs and mcp_tool.rs at openai/codex@ebd0765. Keep the pass order and byte
 * accounting identical to the Rust code: Codex measures the subset, not the server's schema.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

export const CODEX_SCHEMA_MAX_BYTES = 5_000;
const MAX_COMPACT_DEPTH = 3;
const DEFINITION_TABLES = ["$defs", "definitions"] as const;
const CHILD_KEYS = ["items", "anyOf", "oneOf", "allOf"] as const;
const COMPOSITION_KEYS = ["anyOf", "oneOf", "allOf"] as const;
const PRIMITIVE_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "integer",
  "object",
  "array",
  "null",
]);

export type CodexCompactionPass =
  | "strip-descriptions"
  | "drop-definitions"
  | "collapse-deep-objects"
  | "prune-compositions";

export interface CodexSchemaReduction {
  /** The subset Codex would send before compaction. */
  schema: JsonObject;
  /** UTF-8 bytes of `schema` as compact JSON. */
  bytes: number;
  /** Compaction passes Codex runs because the subset is over budget, in order. */
  passes: CodexCompactionPass[];
  /** The schema the model finally sees. */
  compacted: JsonObject;
}

/**
 * Returns what Codex does to `inputSchema`, or undefined when Codex can't parse it (it then drops
 * the tool for reasons outside these checks).
 */
export function reduceCodexInputSchema(
  inputSchema: unknown,
  maxBytes = CODEX_SCHEMA_MAX_BYTES,
): CodexSchemaReduction | undefined {
  if (!isObject(inputSchema)) return undefined;
  const value = structuredClone(inputSchema) as JsonObject;
  if (value.properties === undefined || value.properties === null) value.properties = {};
  let working: Json = value;
  sanitize(working, (next) => (working = next));
  pruneUnreachableDefinitions(working);

  const passes: CodexCompactionPass[] = [];
  let first: { schema: JsonObject; bytes: number } | undefined;
  try {
    for (const [name, pass] of COMPACTION_PASSES) {
      const schema = toSubset(working);
      const bytes = jsonBytes(schema);
      first ??= { schema, bytes };
      if (bytes <= maxBytes) return { ...first, passes, compacted: schema };
      passes.push(name);
      working = pass(working);
    }
    return { ...first!, passes, compacted: toSubset(working) };
  } catch {
    return undefined;
  }
}

const encoder = new TextEncoder();

export function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

// sanitize_json_schema: rewrites in place; `replace` swaps the current node.
function sanitize(value: Json, replace: (next: Json) => void): void {
  if (typeof value === "boolean") {
    replace({ type: "string" });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => sanitize(item, (next) => (value[index] = next)));
    return;
  }
  if (!isObject(value)) return;
  const map = value;
  if (isObject(map.properties))
    for (const key of Object.keys(map.properties)) {
      const properties = map.properties;
      sanitize(properties[key]!, (next) => (properties[key] = next));
    }
  if ("items" in map) sanitize(map.items!, (next) => (map.items = next));
  if ("additionalProperties" in map && typeof map.additionalProperties !== "boolean")
    sanitize(map.additionalProperties!, (next) => (map.additionalProperties = next));
  if ("prefixItems" in map) sanitize(map.prefixItems!, (next) => (map.prefixItems = next));
  for (const key of COMPOSITION_KEYS)
    if (key in map) sanitize(map[key]!, (next) => (map[key] = next));
  for (const table of DEFINITION_TABLES) {
    if (!(table in map)) continue;
    const definitions = map[table];
    if (!isObject(definitions)) {
      delete map[table];
      continue;
    }
    for (const key of Object.keys(definitions))
      sanitize(definitions[key]!, (next) => (definitions[key] = next));
  }

  if ("const" in map) {
    map.enum = [map.const!];
    delete map.const;
  }

  const types = normalizedTypes(map);
  if (types.length === 0 && ("$ref" in map || COMPOSITION_KEYS.some((key) => key in map))) return;
  if (types.length === 0) {
    if ("properties" in map || "required" in map || "additionalProperties" in map)
      types.push("object");
    else if ("items" in map || "prefixItems" in map) types.push("array");
    else if ("enum" in map || "format" in map) types.push("string");
    else if (
      ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"].some(
        (key) => key in map,
      )
    )
      types.push("number");
    else {
      for (const key of Object.keys(map)) delete map[key];
      return;
    }
  }
  if (types.length === 1) map.type = types[0]!;
  else map.type = types;
  if (types.includes("object") && !("properties" in map)) map.properties = {};
  if (types.includes("array") && !("items" in map)) map.items = { type: "string" };
}

function normalizedTypes(map: JsonObject): string[] {
  const type = map.type;
  if (typeof type === "string") return PRIMITIVE_TYPES.has(type) ? [type] : [];
  if (Array.isArray(type))
    return type.filter(
      (item): item is string => typeof item === "string" && PRIMITIVE_TYPES.has(item),
    );
  return [];
}

// for_each_schema_child: properties values, items/anyOf/oneOf/allOf, schema-valued additionalProperties.
function schemaChildren(
  map: JsonObject,
  includeDefinitions: boolean,
): [JsonObject | Json[], string][] {
  const children: [JsonObject | Json[], string][] = [];
  if (isObject(map.properties))
    for (const key of Object.keys(map.properties)) children.push([map.properties, key]);
  for (const key of CHILD_KEYS) if (key in map) children.push([map, key]);
  if ("additionalProperties" in map && typeof map.additionalProperties !== "boolean")
    children.push([map, "additionalProperties"]);
  if (includeDefinitions)
    for (const table of DEFINITION_TABLES) {
      const definitions = map[table];
      if (isObject(definitions))
        for (const key of Object.keys(definitions)) children.push([definitions, key]);
    }
  return children;
}

function visit(
  value: Json,
  replace: (next: Json) => void,
  onObject: (map: JsonObject, replace: (next: Json) => void) => boolean,
  includeDefinitions: boolean,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      visit(item, (next) => (value[index] = next), onObject, includeDefinitions),
    );
    return;
  }
  if (!isObject(value)) return;
  if (!onObject(value, replace)) return;
  for (const [parent, key] of schemaChildren(value, includeDefinitions)) {
    const container = parent as Record<string, Json>;
    visit(container[key]!, (next) => (container[key] = next), onObject, includeDefinitions);
  }
}

function pruneUnreachableDefinitions(value: Json): void {
  if (!isObject(value)) return;
  const reachable = new Set<string>();
  const pending: [string, string][] = [];
  const collectOutside = (node: Json): void => {
    visit(
      node,
      () => {},
      (map) => {
        const ref = definitionRef(map.$ref);
        if (ref) pending.push(ref);
        return true;
      },
      false,
    );
  };
  collectOutside(value);
  while (pending.length) {
    const [table, name] = pending.pop()!;
    const id = `${table}\0${name}`;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const definitions = value[table];
    const definition = isObject(definitions) ? definitions[name] : undefined;
    if (definition !== undefined) collectAllRefs(definition, pending);
  }
  for (const table of DEFINITION_TABLES) {
    const definitions = value[table];
    if (!isObject(definitions)) continue;
    for (const name of Object.keys(definitions))
      if (!reachable.has(`${table}\0${name}`)) delete definitions[name];
    if (Object.keys(definitions).length === 0) delete value[table];
  }
}

function collectAllRefs(value: Json, refs: [string, string][]): void {
  if (Array.isArray(value)) for (const item of value) collectAllRefs(item, refs);
  else if (isObject(value)) {
    const ref = definitionRef(value.$ref);
    if (ref) refs.push(ref);
    for (const child of Object.values(value)) collectAllRefs(child, refs);
  }
}

// parse_local_definition_ref: `#/$defs/<name>/...` or `#/definitions/<name>/...`, percent-decoded.
function definitionRef(ref: Json | undefined): [string, string] | undefined {
  if (typeof ref !== "string" || !ref.startsWith("#")) return undefined;
  let pointer: string;
  try {
    pointer = decodeURIComponent(ref.slice(1));
  } catch {
    return undefined;
  }
  if (!pointer.startsWith("/")) return undefined;
  const tokens = pointer
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
  const table = DEFINITION_TABLES.find((candidate) => candidate === tokens[0]);
  if (!table || tokens.length < 2) return undefined;
  return [table, tokens[1]!];
}

const COMPACTION_PASSES: [CodexCompactionPass, (value: Json) => Json][] = [
  [
    "strip-descriptions",
    (value) => {
      visit(
        value,
        () => {},
        (map) => {
          delete map.description;
          return true;
        },
        true,
      );
      return value;
    },
  ],
  [
    "drop-definitions",
    (value) => {
      let root = value;
      visit(
        value,
        (next) => (root = next),
        (map, replace) => {
          if (definitionRef(map.$ref)) {
            replace({});
            return false;
          }
          return true;
        },
        false,
      );
      if (isObject(root)) for (const table of DEFINITION_TABLES) delete root[table];
      return root;
    },
  ],
  [
    "collapse-deep-objects",
    (value) => {
      collapseDeep(value, 0, () => {});
      return value;
    },
  ],
  [
    "prune-compositions",
    (value) => {
      let root = value;
      visit(
        value,
        (next) => (root = next),
        (map, replace) => {
          if (COMPOSITION_KEYS.some((key) => key in map)) {
            replace({});
            return false;
          }
          return true;
        },
        false,
      );
      return root;
    },
  ],
];

// The root is depth 0 and an array of schemas keeps its parent's depth, as in the Rust code.
function collapseDeep(value: Json, depth: number, replace: (next: Json) => void): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collapseDeep(item, depth, (next) => (value[index] = next)));
    return;
  }
  if (!isObject(value)) return;
  if (depth >= MAX_COMPACT_DEPTH && isComplex(value)) {
    replace({});
    return;
  }
  for (const [parent, key] of schemaChildren(value, false)) {
    const container = parent as Record<string, Json>;
    collapseDeep(container[key]!, depth + 1, (next) => (container[key] = next));
  }
}

function isComplex(map: JsonObject): boolean {
  return (
    CHILD_KEYS.some((key) => key in map) ||
    "properties" in map ||
    "additionalProperties" in map ||
    "$ref" in map
  );
}

class UnsupportedSchema extends Error {}

/** Deserializes into Codex's `JsonSchema` struct and back: unknown keywords vanish, wrong shapes throw. */
function toSubset(value: Json): JsonObject {
  if (!isObject(value)) throw new UnsupportedSchema("schema is not an object");
  const out: JsonObject = {};
  const string = (key: string) => {
    const field = value[key];
    if (field === undefined || field === null) return;
    if (typeof field !== "string") throw new UnsupportedSchema(key);
    out[key] = field;
  };
  string("$ref");
  const type = value.type;
  if (type !== undefined && type !== null) {
    const valid = (item: Json) => typeof item === "string" && PRIMITIVE_TYPES.has(item);
    if (Array.isArray(type) ? !type.every(valid) : !valid(type))
      throw new UnsupportedSchema("type");
    out.type = type;
  }
  string("description");
  if (value.encrypted !== undefined && value.encrypted !== null) {
    if (typeof value.encrypted !== "boolean") throw new UnsupportedSchema("encrypted");
    out.encrypted = value.encrypted;
  }
  if (value.enum !== undefined && value.enum !== null) {
    if (!Array.isArray(value.enum)) throw new UnsupportedSchema("enum");
    out.enum = value.enum;
  }
  if (value.items !== undefined && value.items !== null) out.items = toSubset(value.items);
  if (value.minItems !== undefined && value.minItems !== null) {
    if (!Number.isInteger(value.minItems) || (value.minItems as number) < 0)
      throw new UnsupportedSchema("minItems");
    out.minItems = value.minItems;
  }
  if (value.properties !== undefined && value.properties !== null)
    out.properties = subsetMap(value.properties);
  if (value.required !== undefined && value.required !== null) {
    if (!Array.isArray(value.required) || !value.required.every((item) => typeof item === "string"))
      throw new UnsupportedSchema("required");
    out.required = value.required;
  }
  const additional = value.additionalProperties;
  if (additional !== undefined && additional !== null)
    out.additionalProperties = typeof additional === "boolean" ? additional : toSubset(additional);
  for (const key of COMPOSITION_KEYS) {
    const list = value[key];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) throw new UnsupportedSchema(key);
    out[key] = list.map(toSubset);
  }
  for (const table of DEFINITION_TABLES)
    if (value[table] !== undefined && value[table] !== null) out[table] = subsetMap(value[table]);
  return out;
}

function subsetMap(value: Json): JsonObject {
  if (!isObject(value)) throw new UnsupportedSchema("map");
  const out: JsonObject = {};
  for (const [key, child] of Object.entries(value)) out[key] = toSubset(child);
  return out;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
