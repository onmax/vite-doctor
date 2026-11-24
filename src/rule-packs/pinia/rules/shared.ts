import { dirname, isAbsolute, relative, resolve } from "pathe";
import type { NuxtProjectInfo, RuleContext } from "../../../core/index.js";
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
  runtimes: number;
  reads: Array<{ start: number; end: number; runtimes: number }>;
}

const CLIENT = 1;
const SERVER = 2;
export const setupRuntimes = [CLIENT, SERVER];

export type SetupStoreUseTarget =
  /** A store defined in the same file under `name`. */
  | { kind: "local"; start: number }
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

export interface LocatedStore<S extends StoreDefinition = StoreDefinition> {
  store: S;
  module: StoreModule;
}

const VITE_EXTENSIONS = [".mjs", ".js", ".mts", ".ts", ".jsx", ".tsx", ".json"];

const TRANSPARENT_WRAPPERS = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
]);

const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionExpression"]);
const UNKNOWN_OPTION = Symbol("unknown Vue watcher option");
const EARLY_STORE_PROPERTIES = new Set([
  "$id",
  "$patch",
  "$reset",
  "$subscribe",
  "$onAction",
  "$dispose",
]);

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
export function findStoreUses(
  program: AnyNode,
  source: string,
  nuxt?: NuxtProjectInfo,
): StoreWithUses[] {
  const { definitions, references } = analyzeStoreScript(program, source);
  const local = new Set(definitions.flatMap((definition) => definition.binding?.start ?? []));
  return definitions.map((definition) => ({
    ...definition,
    uses: definition.setup ? setupUses(definition.setup, references, local, nuxt) : [],
  }));
}

/** Scanned script and SFC files that mention `defineStore`, parsed. */
export async function collectStoreModules(
  ctx: RuleContext,
  sourcePaths?: readonly string[],
): Promise<StoreModule[]> {
  const files =
    sourcePaths ??
    (await selectScanFiles(ctx.project.root, {}, {}, ctx.project))
      .filter((entry) => entry.sourceKind !== "module")
      .map((entry) => entry.path);
  const modules: StoreModule[] = [];
  for (const file of files) {
    if (/\.mdc?$/.test(file)) continue;
    const text = ctx.fs.readText(file);
    if (!text?.includes("defineStore")) continue;
    const program = file.endsWith(".vue")
      ? parseVueScripts(file, (await parseSfcFile(file, text)).descriptor, text)
      : parseScript(file, text);
    modules.push({ file, displayPath: relative(ctx.project.root, file), text, program });
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
  const definitions: StoreDefinition[] = [];
  walk(program, [], (node, ancestors) => {
    if (node.type !== "CallExpression") return;
    const callee = unwrap(node.callee);
    if (
      importedCallee(callee, references, "pinia") !== "defineStore" &&
      !(
        callee?.type === "Identifier" &&
        callee.name === "defineStore" &&
        references.get(callee.start)?.resolved === null
      )
    )
      return;
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

function importedCallee(
  node: AnyNode,
  references: Map<number, ScopeReference>,
  source: string,
): string | undefined {
  const binding = calleeImport(node, references);
  return binding?.from === source ? binding.name : undefined;
}

function calleeImport(
  node: AnyNode,
  references: Map<number, ScopeReference>,
  nuxt?: NuxtProjectInfo,
): { from: string; name: string } | undefined {
  return resolvedCalleeImport(node, (identifier) => references.get(identifier.start), nuxt);
}

export function resolvedCalleeImport(
  node: AnyNode,
  referenceOf: (identifier: AnyNode) => ScopeReference | undefined,
  nuxt?: NuxtProjectInfo,
): { from: string; name: string } | undefined {
  const callee = unwrap(node);
  const member = callee?.type === "MemberExpression";
  const identifier = member ? unwrap(callee.object) : callee;
  if (identifier?.type !== "Identifier") return undefined;
  const reference = referenceOf(identifier);
  if (!reference?.isValueReference) return undefined;
  if (!reference.resolved && !member && nuxt?.autoImportEnabled)
    return nuxtValueImport(nuxt, identifier.name);
  const definitions = reference.resolved?.defs;
  if (definitions?.length !== 1) return undefined;
  const definition = definitions[0]!;
  if (
    definition.type !== "ImportBinding" ||
    definition.parent.type !== "ImportDeclaration" ||
    definition.parent.importKind === "type"
  )
    return undefined;
  const binding = definition.node;
  const name =
    member && binding.type === "ImportNamespaceSpecifier"
      ? memberName(callee)
      : !member && binding.type === "ImportSpecifier" && binding.importKind !== "type"
        ? importedName(binding)
        : undefined;
  if (name === undefined) return undefined;
  const from = String(definition.parent.source.value);
  return from === "#imports" ? nuxtValueImport(nuxt, name) : { from, name };
}

export function nuxtValueImport(nuxt: NuxtProjectInfo | undefined, name: string) {
  const entry = nuxt?.autoImportsAuthoritative ? nuxt.autoImports.get(name) : undefined;
  return entry && !entry.type ? entry : undefined;
}

function isRefHelper(
  node: AnyNode,
  references: Map<number, ScopeReference>,
  nuxt?: NuxtProjectInfo,
) {
  const binding = calleeImport(node, references, nuxt);
  if (!binding) return false;
  const from = binding.from.replaceAll("\\", "/");
  return (
    (binding.name === "toRefs" && from === "vue") ||
    (binding.name === "storeToRefs" &&
      (from === "pinia" ||
        /(?:^|\/)node_modules\/@pinia\/nuxt\/dist\/runtime\/composables(?:\.[cm]?js)?$/.test(from)))
  );
}

function setupUses(
  setup: AnyNode,
  references: Map<number, ScopeReference>,
  localStores: Set<number>,
  nuxt?: NuxtProjectInfo,
): SetupStoreUse[] {
  const uses: SetupStoreUse[] = [];
  const bindings = new Map<unknown, SetupStoreUse>();
  const identifiers: Array<{ node: AnyNode; ancestors: AnyNode[] }> = [];
  walkSynchronous(setup.body, references, (node, ancestors) => {
    if (node.type === "Identifier") identifiers.push({ node, ancestors: [...ancestors] });
    if (node.type !== "CallExpression") return;
    const callee = unwrap(node.callee);
    if (callee?.type !== "Identifier") return;
    const target = storeUseTarget(references.get(callee.start), callee.name, localStores);
    if (!target) return;
    const runtimes = executionRuntimes(node, ancestors);
    if (!runtimes) return;
    const use: SetupStoreUse = {
      callee: { name: callee.name, start: callee.start, end: callee.end },
      target,
      runtimes,
      reads: [],
    };
    uses.push(use);
    const { expression, parent } = enclosing(node, ancestors);
    const read = readOf(expression, parent, ancestors, references, nuxt);
    if (read) use.reads.push({ ...read, runtimes });
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
    const read = readOf(expression, parent, ancestors, references, nuxt);
    const runtimes = use.runtimes & executionRuntimes(node, ancestors);
    if (read && runtimes) use.reads.push({ ...read, runtimes });
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
    return { kind: "local", start: definition.name.range[0] };
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
  references: Map<number, ScopeReference>,
  nuxt?: NuxtProjectInfo,
): { start: number; end: number } | undefined {
  if (!parent) return undefined;
  if (parent.type === "MemberExpression" && parent.object === expression) {
    const name = memberName(parent);
    if (name === undefined || EARLY_STORE_PROPERTIES.has(name)) return undefined;
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
    isRefHelper(parent.callee, references, nuxt)
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

function memberName(node: AnyNode): string | undefined {
  return node.computed ? staticString(node.property) : node.property?.name;
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
function walkSynchronous(
  body: AnyNode,
  references: Map<number, ScopeReference>,
  visit: (node: AnyNode, ancestors: AnyNode[]) => void,
) {
  walk(body, [], (node, ancestors) => {
    visit(node, ancestors);
    return (
      !DEFERRED_SCOPES.has(node.type) ||
      (FUNCTIONS.has(node.type) && eagerlyInvoked(node, ancestors, references))
    );
  });
}

function eagerlyInvoked(
  node: AnyNode,
  ancestors: AnyNode[],
  references: Map<number, ScopeReference>,
) {
  const { expression, parent } = enclosing(node, ancestors);
  const call = parent?.type === "ArrayExpression" ? ancestors.at(-2) : parent;
  if (call?.type !== "CallExpression" || node.async || node.generator) return false;
  if (call.callee === expression) return true;
  const api = importedCallee(call.callee, references, "vue");
  const [source, callback, options] = call.arguments;
  if (api === "watch") {
    if (source === expression || source === parent) return true;
    return callback === expression && optionValue(options, "immediate") === true;
  }
  if (source !== expression) return false;
  const flush = optionValue(callback, "flush");
  return (
    api === "watchSyncEffect" ||
    (api === "watchEffect" && (flush === undefined || flush === "pre" || flush === "sync"))
  );
}

function optionValue(options: AnyNode, name: string): unknown {
  if (!options) return undefined;
  const object = unwrap(options);
  if (object?.type !== "ObjectExpression") return UNKNOWN_OPTION;
  for (let index = object.properties.length - 1; index >= 0; index--) {
    const property = object.properties[index];
    if (property.type !== "Property" || property.computed) return UNKNOWN_OPTION;
    if ((property.key.name ?? property.key.value) !== name) continue;
    const value = unwrap(property.value);
    return value?.type === "Literal" ? value.value : UNKNOWN_OPTION;
  }
  return undefined;
}

function executionRuntimes(node: AnyNode, ancestors: AnyNode[]): number {
  let runtimes = CLIENT | SERVER;
  let child = node;
  for (let index = ancestors.length - 1; index >= 0; index--) {
    const parent = ancestors[index];
    if (
      (parent.type === "IfStatement" || parent.type === "ConditionalExpression") &&
      child !== parent.test
    )
      runtimes &= conditionRuntimes(parent.test, child === parent.consequent);
    if (parent.type === "LogicalExpression" && child === parent.right)
      runtimes &=
        parent.operator === "??" ? 0 : conditionRuntimes(parent.left, parent.operator === "&&");
    child = parent;
  }
  return runtimes;
}

function conditionRuntimes(node: AnyNode, truthy: boolean): number {
  const test = unwrap(node);
  if (test?.type === "UnaryExpression" && test.operator === "!")
    return conditionRuntimes(test.argument, !truthy);
  if (test?.type === "Literal" && typeof test.value === "boolean")
    return test.value === truthy ? CLIENT | SERVER : 0;
  if (test?.type === "LogicalExpression" && test.operator !== "??") {
    const left = conditionRuntimes(test.left, truthy);
    const right = conditionRuntimes(test.right, truthy);
    return (test.operator === "&&") === truthy ? left & right : left | right;
  }
  const object = unwrap(test?.object);
  if (
    test?.type === "MemberExpression" &&
    memberName(test) === "SSR" &&
    object?.type === "MemberExpression" &&
    memberName(object) === "env" &&
    object.object?.type === "MetaProperty" &&
    object.object.meta?.name === "import" &&
    object.object.property?.name === "meta"
  )
    return truthy ? SERVER : CLIENT;
  return 0;
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

/**
 * Resolves a `useXStore` reference in `file` to the store it calls: through imports, re-exports,
 * and Nuxt's auto-import registrations, or, with no import and no authoritative registrations, to
 * the only store exported under that name (`byName`), as `@pinia/nuxt` and `unplugin-auto-import`
 * would resolve it.
 */
export function storeResolver<S extends StoreDefinition>(
  ctx: RuleContext,
  stores: LocatedStore<S>[],
) {
  const byFile = new Map<string, LocatedStore<S>[]>();
  const programs = new Map<string, StoreModule["program"]>();
  for (const store of stores) {
    const file = store.module.file;
    const local = byFile.get(file) ?? [];
    local.push(store);
    byFile.set(file, local);
    programs.set(file, store.module.program);
  }

  function moduleFile(from: string, source: string) {
    const matches = new Set(
      importBases(ctx, from, source).flatMap((base) => {
        const file = importCandidates(base).find(
          (candidate) => byFile.has(candidate) || ctx.fs.stat(candidate)?.isFile(),
        );
        return file ? [file] : [];
      }),
    );
    return matches.size === 1 ? matches.values().next().value : undefined;
  }

  function program(file: string) {
    if (!programs.has(file)) {
      const text = ctx.fs.readText(file);
      programs.set(file, text && !file.endsWith(".vue") ? parseScript(file, text) : undefined);
    }
    return programs.get(file);
  }

  function declarationStore(file: string, declaration: StoreModule["program"], name: string) {
    const binding = declaration?.declarations?.find(
      (entry: StoreModule["program"]) => entry.id?.type === "Identifier" && entry.id.name === name,
    )?.id;
    return (
      binding &&
      byFile.get(file)?.find((candidate) => candidate.store.binding?.start === binding.start)
    );
  }

  // `null` means the export might exist but cannot be proven to be a store; `undefined` means absent.
  function exported(
    file: string,
    name: string,
    seen = new Set<string>(),
  ): LocatedStore<S> | null | undefined {
    const key = `${file}\0${name}`;
    if (seen.has(key)) return undefined;
    const body = program(file)?.body;
    if (!body) return null;
    const path = new Set(seen).add(key);
    for (const statement of body) {
      if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue;
      const declaration = statement.declaration;
      if (declaration?.id?.name === name) return null;
      if (declaration?.type === "VariableDeclaration") {
        const store = declarationStore(file, declaration, name);
        if (store) return store;
        if (
          declaration.declarations.some((entry: StoreModule["program"]) =>
            bindsName(entry.id, name),
          )
        )
          return null;
      }
      for (const item of statement.specifiers ?? []) {
        if (item.exportKind === "type" || exportName(item.exported) !== name) continue;
        const local = exportName(item.local);
        if (!local) return null;
        if (statement.source) {
          const target = moduleFile(file, statement.source.value);
          return (target && exported(target, local, path)) || null;
        }
        for (const binding of body) {
          const store = declarationStore(file, binding.declaration ?? binding, local);
          if (store) return store;
          if (binding.type !== "ImportDeclaration" || binding.importKind === "type") continue;
          const imported = binding.specifiers.find(
            (entry: StoreModule["program"]) => entry.local.name === local,
          );
          if (imported?.type !== "ImportSpecifier" || imported.importKind === "type") continue;
          const target = moduleFile(file, binding.source.value);
          return (target && exported(target, exportName(imported.imported), path)) || null;
        }
        return null;
      }
    }
    let match: LocatedStore<S> | undefined;
    for (const statement of body) {
      if (statement.type !== "ExportAllDeclaration" || statement.exportKind === "type") continue;
      if (statement.exported) {
        if (exportName(statement.exported) === name) return null;
        continue;
      }
      const target = moduleFile(file, statement.source.value);
      if (!target) return null;
      const store = exported(target, name, path);
      if (store === null || (store && match && match !== store)) return null;
      match ??= store;
    }
    return match;
  }

  return (
    file: string,
    target: SetupStoreUseTarget,
  ): { store: LocatedStore<S>; byName: boolean } | undefined => {
    const ownPackage = packageRoot(ctx, file);
    const nuxt = nuxtForFile(ctx, file);
    if (target.kind === "local") {
      const store = byFile.get(file)?.find((item) => item.store.binding?.start === target.start);
      return store && { store, byName: false };
    }
    if (target.kind === "import" && target.source !== "#imports") {
      const imported = moduleFile(file, target.source);
      const store = imported && exported(imported, target.name);
      return store ? { store, byName: false } : undefined;
    }
    if (target.kind === "auto-import" && nuxt?.autoImportEnabled === false) return undefined;
    if (nuxt?.autoImportsAuthoritative) {
      const registration = nuxtValueImport(nuxt, target.name);
      const imported = registration && moduleFile(file, registration.from);
      const store = imported && exported(imported, registration.name);
      return store ? { store, byName: false } : undefined;
    }
    if (target.kind === "import" || nuxt?.autoImports.has(target.name)) return undefined;
    const named = [
      ...new Set([...byFile.keys()].flatMap((candidate) => exported(candidate, target.name) ?? [])),
    ];
    const samePackage = named.filter((store) => packageRoot(ctx, store.module.file) === ownPackage);
    const candidates = samePackage.length ? samePackage : named;
    return candidates.length === 1 ? { store: candidates[0]!, byName: true } : undefined;
  };
}

function exportName(node: StoreModule["program"]): string {
  return node?.name ?? node?.value;
}

function bindsName(pattern: StoreModule["program"], name: string): boolean {
  switch (pattern?.type) {
    case "Identifier":
      return pattern.name === name;
    case "RestElement":
      return bindsName(pattern.argument, name);
    case "AssignmentPattern":
      return bindsName(pattern.left, name);
    case "ArrayPattern":
      return pattern.elements.some((element: StoreModule["program"]) => bindsName(element, name));
    case "ObjectPattern":
      return pattern.properties.some((property: StoreModule["program"]) =>
        bindsName(property.value ?? property.argument, name),
      );
    default:
      return false;
  }
}

function importBases(ctx: RuleContext, from: string, specifier: string): string[] {
  const bare = specifier.split("?")[0]!;
  const root = ctx.project.root;
  const own = packageRoot(ctx, from);
  let bases: string[] = [];
  if (isAbsolute(bare)) bases = [bare];
  else if (bare.startsWith("./") || bare.startsWith("../")) bases = [resolve(dirname(from), bare)];
  else if (/^(?:~~|@@)\//.test(bare))
    bases = [own, root].map((base) => resolve(base, bare.slice(3)));
  else if (/^[~@]\//.test(bare)) {
    const appDir = nuxtForFile(ctx, from)?.appDir;
    bases = [
      ...(appDir ? [appDir] : []),
      ...[own, root].flatMap((base) => [resolve(base, "app"), resolve(base, "src"), base]),
    ].map((base) => resolve(base, bare.slice(2)));
  }
  return bases;
}

function importCandidates(base: string): string[] {
  const ts = base.replace(/\.([cm]?)js(x?)$/, ".$1ts$2");
  return [
    base,
    ...(ts === base ? [] : [ts]),
    ...VITE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...VITE_EXTENSIONS.map((extension) => `${base}/index${extension}`),
  ];
}

export function nuxtForFile(ctx: RuleContext, file: string) {
  const ownPackage = packageRoot(ctx, file);
  return (
    ctx.project.workspaceNuxt?.find((item) => resolve(ctx.project.root, item.root) === ownPackage)
      ?.nuxt ?? ctx.project.nuxt
  );
}

function packageRoot(ctx: RuleContext, file: string): string {
  const roots = (ctx.project.workspacePackages ?? [])
    .map((item) => resolve(ctx.project.root, item.root))
    .filter((root) => file.startsWith(`${root}/`))
    .sort((left, right) => right.length - left.length);
  return roots[0] ?? ctx.project.root;
}
