import type { RuleContext } from "../../../core/index.js";
import { parseScript } from "../../../core/internal/script.js";
import { parseScriptScope, type ScopeReference } from "../../../core/internal/script-scope.js";
import { parseSfcFile, parseVueScripts } from "../../../core/internal/sfc.js";
// oxlint-disable-next-line no-restricted-imports -- walks the project tree, so the Rules that call it declare cacheScope "none".
import { selectScanFiles } from "../../../core/internal/source-inventory.js";
import { getNodeVisitorKeys } from "../../../core/internal/visitor-keys.js";

type AnyNode = any;

export interface StoreDefinition {
  id: string;
  idStart: number;
  idEnd: number;
  binding?: { name: string; start: number; end: number };
  /** The setup function of a setup store; option stores have none. */
  setup?: AnyNode;
}

/** A `useXStore()` call at the top level of a setup function, and its top-level reads. */
export interface SetupStoreUse {
  callee: { name: string; start: number; end: number };
  target: SetupStoreUseTarget;
  reads: Array<{ start: number; end: number }>;
}

export type SetupStoreUseTarget =
  /** A store defined in the same file under `name`. */
  | { kind: "local"; name: string }
  /** `name` imported from `source`. */
  | { kind: "import"; name: string; source: string }
  /** No import or declaration, as with `@pinia/nuxt` or `unplugin-auto-import`. */
  | { kind: "auto-import"; name: string };

export interface StoreWithUses extends StoreDefinition {
  /** Empty for option stores. */
  uses: SetupStoreUse[];
}

export interface StoreModule {
  file: string;
  displayPath: string;
  text: string;
  program: AnyNode;
}

const TRANSPARENT_WRAPPERS = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
]);

const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionExpression"]);

// Code in these nodes runs later than the setup function body, or not at all.
const DEFERRED_SCOPES = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
  "ClassDeclaration",
  "ClassExpression",
]);

export function findStoreDefinitions(program: AnyNode, source: string): StoreDefinition[] {
  return analyzeStoreScript(program, source).definitions;
}

/**
 * Store definitions with the stores each setup function uses synchronously: `useXStore()` calls
 * outside nested functions, and the property reads, destructuring, and `storeToRefs()` calls on
 * their result that also run before the setup function returns.
 */
export function findStoreUses(program: AnyNode, source: string): StoreWithUses[] {
  const { definitions, references } = analyzeStoreScript(program, source);
  const local = new Set(definitions.flatMap((definition) => definition.binding?.start ?? []));
  return definitions.map((definition) => ({
    ...definition,
    uses: definition.setup ? setupUses(definition.setup, references, local) : [],
  }));
}

/** Scanned script and SFC files that mention `defineStore`, parsed. */
export async function collectStoreModules(ctx: RuleContext): Promise<StoreModule[]> {
  const files = await selectScanFiles(ctx.project.root, {}, {}, ctx.project);
  const modules: StoreModule[] = [];
  for (const entry of files) {
    if (entry.sourceKind === "module" || /\.mdc?$/.test(entry.path)) continue;
    const text = ctx.fs.readText(entry.path);
    if (!text?.includes("defineStore")) continue;
    const program = entry.path.endsWith(".vue")
      ? parseVueScripts(entry.path, (await parseSfcFile(entry.path, text)).descriptor, text)
      : parseScript(entry.path, text);
    modules.push({ file: entry.path, displayPath: entry.displayPath, text, program });
  }
  return modules;
}

export function expectedStoreName(id: string): string {
  const words = id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (words.at(-1)?.toLowerCase() === "store") words.pop();
  return `use${words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join("")}Store`;
}

export function isConventionalStoreName(name: string, id: string): boolean {
  return normalizeName(name) === normalizeName(expectedStoreName(id));
}

function normalizeName(name: string) {
  return name.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function analyzeStoreScript(
  program: AnyNode,
  source: string,
): { definitions: StoreDefinition[]; references: Map<number, ScopeReference> } {
  if (program?.type !== "Program") return { definitions: [], references: new Map() };
  const references = scopeReferences(program, source);
  const callees = piniaDefineStoreCallees(program, references);
  const definitions: StoreDefinition[] = [];
  walk(program, [], (node, ancestors) => {
    if (node.type !== "CallExpression" || !callees.has(unwrap(node.callee)?.start)) return;
    const id = readStoreId(node);
    if (!id) return;
    definitions.push({ ...id, binding: readBinding(node, ancestors), setup: readSetup(node) });
  });
  return { definitions, references };
}

/** Scope references keyed by identifier offset, or none when the script cannot be analyzed. */
function scopeReferences(program: AnyNode, source: string): Map<number, ScopeReference> {
  const references = new Map<number, ScopeReference>();
  // Preserve offsets while excluding SFC markup outside the parsed script statements.
  const script: string[] = source
    .split("")
    .map((char) => (/^[\n\r\u2028\u2029]$/.test(char) ? char : " "));
  for (const statement of program.body ?? []) {
    for (let offset = statement.start; offset < statement.end; offset++)
      script[offset] = source[offset]!;
  }
  let jsx = false;
  walk(program, [], (node) => {
    if (node.type === "JSXElement" || node.type === "JSXFragment") jsx = true;
  });
  try {
    const { scopeManager } = parseScriptScope(script.join(""), {
      dialect: jsx ? "tsx" : "ts",
      sourceType: "module",
    });
    for (const scope of scopeManager.scopes) {
      for (const reference of scope.references)
        references.set(reference.identifier.range[0], reference);
    }
  } catch {
    // Without binding evidence, recovered or unsupported syntax cannot establish a Pinia call.
  }
  return references;
}

function piniaDefineStoreCallees(
  program: AnyNode,
  references: Map<number, ScopeReference>,
): Set<number> {
  const callees = new Set<number>();
  const identifiers = new Set<number>();
  const namespaces = new Set<number>();
  for (const reference of references.values()) {
    if (!reference.isValueReference) continue;
    const identifier = reference.identifier;
    const variable = reference.resolved;
    if (!variable) {
      if (identifier.name === "defineStore") identifiers.add(identifier.range[0]);
      continue;
    }
    for (const definition of variable.defs) {
      if (
        definition.type !== "ImportBinding" ||
        definition.parent.type !== "ImportDeclaration" ||
        definition.parent.source.value !== "pinia" ||
        definition.parent.importKind === "type"
      )
        continue;
      const binding = definition.node;
      if (
        binding.type === "ImportSpecifier" &&
        binding.importKind !== "type" &&
        importedName(binding) === "defineStore"
      ) {
        identifiers.add(identifier.range[0]);
      } else if (binding.type === "ImportNamespaceSpecifier") {
        namespaces.add(identifier.range[0]);
      }
    }
  }
  walk(program, [], (node) => {
    if (node.type !== "CallExpression") return;
    const callee = unwrap(node.callee);
    if (callee?.type === "Identifier" && identifiers.has(callee.start)) callees.add(callee.start);
    if (
      callee?.type === "MemberExpression" &&
      !callee.computed &&
      callee.object?.type === "Identifier" &&
      namespaces.has(callee.object.start) &&
      callee.property?.name === "defineStore"
    )
      callees.add(callee.start);
  });
  return callees;
}

function setupUses(
  setup: AnyNode,
  references: Map<number, ScopeReference>,
  localStores: Set<number>,
): SetupStoreUse[] {
  const uses: SetupStoreUse[] = [];
  const bindings = new Map<unknown, SetupStoreUse>();
  const identifiers: Array<{ node: AnyNode; ancestors: AnyNode[] }> = [];
  walkSynchronous(setup.body, (node, ancestors) => {
    if (node.type === "Identifier") identifiers.push({ node, ancestors: [...ancestors] });
    if (node.type !== "CallExpression") return;
    const callee = unwrap(node.callee);
    if (callee?.type !== "Identifier") return;
    const target = storeUseTarget(references.get(callee.start), callee.name, localStores);
    if (!target) return;
    const use: SetupStoreUse = {
      callee: { name: callee.name, start: callee.start, end: callee.end },
      target,
      reads: [],
    };
    uses.push(use);
    const { expression, parent } = enclosing(node, ancestors);
    const read = readOf(expression, parent, ancestors);
    if (read) use.reads.push(read);
    if (
      parent?.type === "VariableDeclarator" &&
      parent.init === expression &&
      parent.id?.type === "Identifier"
    ) {
      const variable = references.get(parent.id.start)?.resolved;
      if (variable) bindings.set(variable, use);
    }
  });
  for (const { node, ancestors } of identifiers) {
    const reference = references.get(node.start);
    const use = reference?.isValueReference && bindings.get(reference.resolved);
    if (!use || reference.init) continue;
    const { expression, parent } = enclosing(node, ancestors);
    const read = readOf(expression, parent, ancestors);
    if (read) use.reads.push(read);
  }
  for (const use of uses) use.reads.sort((a, b) => a.start - b.start);
  return uses;
}

function storeUseTarget(
  reference: ScopeReference | undefined,
  name: string,
  localStores: Set<number>,
): SetupStoreUseTarget | undefined {
  if (!reference?.isValueReference) return undefined;
  const variable = reference.resolved;
  if (!variable) return { kind: "auto-import", name };
  if (variable.defs.length !== 1) return undefined;
  const definition = variable.defs[0]!;
  if (
    definition.type === "ImportBinding" &&
    definition.parent.type === "ImportDeclaration" &&
    definition.parent.importKind !== "type" &&
    definition.node.type === "ImportSpecifier" &&
    definition.node.importKind !== "type"
  )
    return {
      kind: "import",
      name: importedName(definition.node),
      source: String(definition.parent.source.value),
    };
  if (definition.type === "Variable" && localStores.has(definition.name.range[0]))
    return { kind: "local", name };
  return undefined;
}

/**
 * The location of a read of `expression`, a store, that runs where it appears: a property access
 * other than Pinia's `$` APIs, which exist before setup finishes, destructuring, a spread, or
 * `storeToRefs()` and `toRefs()`.
 */
function readOf(
  expression: AnyNode,
  parent: AnyNode,
  ancestors: AnyNode[],
): { start: number; end: number } | undefined {
  if (!parent) return undefined;
  if (parent.type === "MemberExpression" && parent.object === expression) {
    const name = parent.computed ? staticString(parent.property) : parent.property?.name;
    if (typeof name !== "string" || name.startsWith("$")) return undefined;
    const outer = enclosing(parent, ancestors.slice(0, ancestors.lastIndexOf(parent)));
    if (
      (outer.parent?.type === "AssignmentExpression" && outer.parent.left === outer.expression) ||
      outer.parent?.type === "UpdateExpression" ||
      (outer.parent?.type === "UnaryExpression" && outer.parent.operator === "delete")
    )
      return undefined;
    return { start: parent.start, end: parent.end };
  }
  if (
    (parent.type === "VariableDeclarator" &&
      parent.init === expression &&
      parent.id?.type === "ObjectPattern") ||
    (parent.type === "AssignmentExpression" &&
      parent.right === expression &&
      parent.left?.type === "ObjectPattern")
  )
    return { start: parent.start, end: parent.end };
  if (parent.type === "SpreadElement") return { start: parent.start, end: parent.end };
  if (
    parent.type === "CallExpression" &&
    parent.arguments?.[0] === expression &&
    ["storeToRefs", "toRefs"].includes(unwrap(parent.callee)?.name)
  )
    return { start: parent.start, end: parent.end };
  return undefined;
}

/** The outermost transparent wrapper around `node` and the node that contains it. */
function enclosing(node: AnyNode, ancestors: AnyNode[]): { expression: AnyNode; parent: AnyNode } {
  let expression = node;
  let index = ancestors.length - 1;
  while (index >= 0 && TRANSPARENT_WRAPPERS.has(ancestors[index].type))
    expression = ancestors[index--];
  return { expression, parent: ancestors[index] };
}

function readStoreId(call: AnyNode): Omit<StoreDefinition, "binding" | "setup"> | undefined {
  const first = call.arguments?.[0];
  const firstNode = unwrap(first);
  if (firstNode?.type === "ObjectExpression") {
    const property = firstNode.properties?.find(
      (item: AnyNode) =>
        item.type === "Property" &&
        !item.computed &&
        (item.key?.name === "id" || item.key?.value === "id"),
    );
    const id = staticString(property?.value);
    if (id === undefined) return undefined;
    return { id, idStart: property.value.start, idEnd: property.value.end };
  }
  const id = staticString(firstNode);
  if (id === undefined) return undefined;
  return { id, idStart: firstNode.start, idEnd: firstNode.end };
}

function readSetup(call: AnyNode): AnyNode | undefined {
  if (unwrap(call.arguments?.[0])?.type === "ObjectExpression") return undefined;
  const setup = unwrap(call.arguments?.[1]);
  return FUNCTIONS.has(setup?.type) ? setup : undefined;
}

function staticString(node: AnyNode): string | undefined {
  const value = unwrap(node);
  if (value?.type === "Literal" && typeof value.value === "string") return value.value;
  if (value?.type === "TemplateLiteral" && value.expressions?.length === 0)
    return value.quasis?.[0]?.value?.cooked ?? undefined;
  return undefined;
}

function importedName(specifier: AnyNode): string {
  return specifier.imported.type === "Identifier"
    ? specifier.imported.name
    : specifier.imported.value;
}

function readBinding(call: AnyNode, ancestors: AnyNode[]): StoreDefinition["binding"] {
  const { expression, parent } = enclosing(call, ancestors);
  if (
    parent?.type !== "VariableDeclarator" ||
    parent.init !== expression ||
    parent.id?.type !== "Identifier"
  )
    return undefined;
  return { name: parent.id.name, start: parent.id.start, end: parent.id.end };
}

function unwrap(node: AnyNode): AnyNode {
  let current = node;
  while (current && TRANSPARENT_WRAPPERS.has(current.type)) current = current.expression;
  return current;
}

/** Walks the code that runs when `body` runs, skipping nested functions and classes. */
function walkSynchronous(body: AnyNode, visit: (node: AnyNode, ancestors: AnyNode[]) => void) {
  walk(body, [], (node, ancestors) => {
    visit(node, ancestors);
    return !DEFERRED_SCOPES.has(node.type);
  });
}

function walk(
  node: AnyNode,
  ancestors: AnyNode[],
  visit: (node: AnyNode, ancestors: AnyNode[]) => boolean | void,
) {
  if (!node || typeof node !== "object" || typeof node.type !== "string") return;
  if (visit(node, ancestors) === false) return;
  ancestors.push(node);
  for (const key of getNodeVisitorKeys(node)) {
    const value = node[key];
    if (Array.isArray(value)) for (const child of value) walk(child, ancestors, visit);
    else walk(value, ancestors, visit);
  }
  ancestors.pop();
}
