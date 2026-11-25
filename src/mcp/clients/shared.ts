import { isSchema, walkSchema, type SchemaNode } from "../schema.js";
import type {
  McpContentItem,
  McpListContext,
  McpSource,
  McpTool,
  McpToolResult,
} from "../types.js";

export const CHECKED = "2026-11-25";

export function docs(url: string, quote: string): McpSource {
  return { url, checked: CHECKED, quote, kind: "docs" };
}

export function source(url: string, quote: string): McpSource {
  return { url, checked: CHECKED, quote, kind: "source" };
}

export function forum(url: string, quote: string): McpSource {
  return { url, checked: CHECKED, quote, kind: "forum" };
}

/**
 * The server name a client prefixes to tool names. Without one, assume a single character so
 * name-length findings only fire when every possible name breaks the limit.
 */
export function serverName(context: McpListContext): { name: string; assumed: boolean } {
  return context.serverName
    ? { name: context.serverName, assumed: false }
    : { name: "s", assumed: true };
}

export function assumedNote(server: { assumed: boolean }): string {
  return server.assumed ? " even with a one-character server name" : "";
}

/** Subschemas of a tool's `inputSchema` reached only through the given keywords, root first. */
export function* schemaNodesVia(
  tool: McpTool,
  keywords: ReadonlySet<string>,
): Generator<SchemaNode & { ancestors: SchemaNode[] }> {
  const root = tool.inputSchema;
  if (!isSchema(root)) return;
  const byPointer = new Map<string, SchemaNode>();
  for (const node of walkSchema(root)) {
    byPointer.set(node.pointer, node);
    const path = keywordPath(root, node.pointer);
    if (!path || !path.every((keyword) => keywords.has(keyword))) continue;
    const ancestors: SchemaNode[] = [];
    for (let pointer = parentPointer(node.pointer); pointer !== undefined;) {
      const ancestor = byPointer.get(pointer);
      if (ancestor) ancestors.push(ancestor);
      pointer = parentPointer(pointer);
    }
    yield { ...node, ancestors };
  }
}

/** The schema keywords a walkSchema pointer passes through, such as `["properties", "items"]`. */
function keywordPath(root: unknown, pointer: string): string[] | undefined {
  const tokens = pointer
    .split("/")
    .slice(1)
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
  const keywords: string[] = [];
  let node: unknown = root;
  for (let index = 0; index < tokens.length; index++) {
    if (!isSchema(node)) return undefined;
    const keyword = tokens[index]!;
    keywords.push(keyword);
    const value = node[keyword];
    const indexed = Array.isArray(value) || (isSchema(value) && MAP_KEYWORDS.has(keyword));
    node = indexed ? (value as Record<string, unknown>)[tokens[++index]!] : value;
  }
  return keywords;
}

const MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "dependencies",
  "$defs",
  "definitions",
  "dependentSchemas",
]);

function parentPointer(pointer: string): string | undefined {
  if (!pointer) return undefined;
  return pointer.slice(0, pointer.lastIndexOf("/"));
}

export function inputPointer(pointer: string): string {
  return `/inputSchema${pointer}`;
}

export function listPointers(pointers: string[], limit = 5): string {
  const shown = pointers.slice(0, limit).map((pointer) => `\`${pointer}\``);
  const rest = pointers.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

export interface DroppedConstraint {
  pointer: string;
  keyword: string;
}

/**
 * Constraint keywords the client removes before the model sees the schema, skipping those whose
 * value the tool description or a description on the way to the keyword already states.
 */
export function undescribedConstraints(
  tool: McpTool,
  dropped: ReadonlySet<string>,
  traversed: ReadonlySet<string>,
  descriptionsReachModel = true,
): DroppedConstraint[] {
  const found: DroppedConstraint[] = [];
  for (const node of schemaNodesVia(tool, traversed)) {
    const texts: unknown[] = [tool.description];
    if (descriptionsReachModel)
      texts.push(
        node.schema.description,
        ...node.ancestors.filter((a) => a.pointer).map((a) => a.schema.description),
      );
    const prose = texts.filter((text): text is string => typeof text === "string").join("\n");
    for (const keyword of Object.keys(node.schema)) {
      if (!dropped.has(keyword)) continue;
      if (node.schema.type === "integer" && isSafeIntegerBound(keyword, node.schema[keyword]))
        continue;
      if (isImplied(keyword, node.schema[keyword])) continue;
      if (mentions(prose, keyword, node.schema[keyword])) continue;
      found.push({ pointer: inputPointer(`${node.pointer}/${keyword}`), keyword });
    }
  }
  return found;
}

// Zod's `.int()` emits these bounds; they reject nothing a model would send.
function isSafeIntegerBound(keyword: string, value: unknown): boolean {
  return (
    (keyword === "minimum" && value === Number.MIN_SAFE_INTEGER) ||
    (keyword === "maximum" && value === Number.MAX_SAFE_INTEGER)
  );
}

// A model already reads an omitted argument as null, false, or empty, and a size minimum of 1
// only rejects an empty value, so neither is something a description has to repeat.
function isImplied(keyword: string, value: unknown): boolean {
  if (keyword === "default")
    return (
      value === null ||
      value === false ||
      value === "" ||
      (typeof value === "object" && Object.keys(value).length === 0)
    );
  return (
    (keyword === "minLength" || keyword === "minItems" || keyword === "minProperties") &&
    typeof value === "number" &&
    value <= 1
  );
}

// The patterns `YYYY-MM-DD` states in full: Zod 4's `z.iso.date()` and the plain digit shape.
const DATE_PATTERNS = new Set([
  String.raw`^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))$`,
  String.raw`^\d{4}-\d{2}-\d{2}$`,
]);

function mentions(prose: string, keyword: string, value: unknown): boolean {
  if (!prose) return false;
  if (typeof value === "number")
    return new RegExp(`(?<![\\d.])${escapeRegExp(String(value))}(?![\\d])`).test(prose);
  if (keyword === "default") return mentionsDefault(prose, value);
  if (typeof value === "boolean")
    return keyword === "uniqueItems" && /unique|duplicate/i.test(prose);
  if (typeof value === "string") {
    if (keyword === "pattern")
      return prose.includes(value) || (DATE_PATTERNS.has(value) && /\bYYYY-MM-DD\b/.test(prose));
    return prose.toLowerCase().includes(value.toLowerCase());
  }
  return prose.includes(JSON.stringify(value));
}

function mentionsDefault(prose: string, value: unknown): boolean {
  for (const declaration of prose.matchAll(/\bdefaults?(?:\s+to\b|\s+is\b|\s*:)?\s*`?/gi)) {
    const literal = prose.slice(declaration.index + declaration[0].length);
    if (typeof value === "boolean" && new RegExp(`^${value}\\b`, "i").test(literal)) return true;
    if (jsonEqual(readDefaultLiteral(literal), value)) return true;
    if (
      typeof value === "string" &&
      value !== "" &&
      new RegExp(`^${escapeRegExp(value)}(?=$|[\\s\x60.,;!?)])`).test(literal)
    )
      return true;
  }
  if (typeof value === "string") {
    for (const match of prose.matchAll(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*\(default\)/gi))
      if (readDefaultLiteral(match[0]) === value) return true;
  }
  if (typeof value !== "boolean") return false;
  return new RegExp(`\\b${value}\`?\\s+by\\s+default\\b`, "i").test(prose);
}

function readDefaultLiteral(text: string): unknown {
  const tokens =
    /\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[[\]{}:,]|(?:true|false|null)\b|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?(?!\w|\.\d))/gy;
  let depth = 0;
  const json = [];
  for (const [, token] of text.matchAll(tokens)) {
    if (token === "[" || token === "{") depth++;
    if (token === "]" || token === "}") depth--;
    json.push(
      token.startsWith("'")
        ? `"${token.slice(1, -1).replace(/\\.|"/g, (part) => (part === "\\'" ? "'" : part === '"' ? '\\"' : part))}"`
        : token,
    );
    if (depth === 0) return parseJson(json.join(""));
  }
  return undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textItems(result: McpToolResult): McpContentItem[] {
  return (result.content ?? []).filter(
    (item) => item?.type === "text" && typeof item.text === "string",
  );
}

export function resultText(result: McpToolResult): string {
  return textItems(result)
    .map((item) => item.text)
    .join("\n");
}

export function textLength(result: McpToolResult): number {
  return textItems(result).reduce((sum, item) => sum + item.text!.length, 0);
}

export function hasImage(result: McpToolResult): boolean {
  return (result.content ?? []).some((item) => item?.type === "image");
}

/** Whether some text item of the result is not the same JSON as `structuredContent`. */
export function structuredContentHidesText(result: McpToolResult): boolean {
  return textItems(result).some(
    (item) => !jsonEqual(parseJson(item.text!), result.structuredContent),
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || !left || !right) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) =>
      Object.hasOwn(right, key) &&
      jsonEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
  );
}
