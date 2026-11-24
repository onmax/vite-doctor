import type { SFCDescriptor } from "@vue/compiler-sfc";
import type { Program } from "oxc-parser";
import type { ImportGraph, RuleContext, SourceRange } from "../primitives.js";
import {
  analyzeScript,
  analyzeScriptProgram,
  type ScopeVariable,
  type ScriptScope,
} from "./script-scope.js";
import { createVueScriptForParsing, parseSfcFile } from "./sfc.js";

/** Shared reactive state exported by a module, as other files import it. */
export interface SharedStateBinding {
  /** The module that declares the state, as an absolute path. */
  file: string;
  /** The name the module exports it under, `default` included. */
  exportName: string;
  /** `ref` state is written through `.value` in script; templates unwrap it. */
  shape: "reactive" | "ref";
  /** `call`: importers write to what calling the export returns, as with Pinia's `useStore()`. */
  access?: "value" | "call";
  /** Known collection initializers, indexed by path relative to the unwrapped state. */
  collectionAt?: CollectionAt;
}

export interface SharedStateWrite {
  /** The writing file, as an absolute path. */
  file: string;
  range: SourceRange;
  kind: "assignment" | "update" | "delete" | "mutating-call" | "v-model";
  in: "script" | "template";
  /** The written expression as source text, such as `store.count` or `items.value`. */
  target: string;
}

export interface LocalStateWrite extends SharedStateWrite {
  enclosingFunction?: Node;
}

type Node = any;
type ParentOf = (node: Node) => Node;
type PropertyPath = readonly (string | null)[];
type CollectionAt = (path: PropertyPath) => "array" | "map" | "set" | undefined;
type IsGlobal = (id: Node) => boolean;

/** How a reference reaches the state: through a namespace member, a call, or both. */
interface Entry {
  slot?: ExportSlot;
  namespace?: boolean;
  call: boolean;
}

interface ExportSlot {
  file: string;
  name: string;
  origins: Array<{ slot: ExportSlot; namespace: boolean }>;
}

const ARRAY_MUTATORS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
]);
const MAP_MUTATORS = new Set(["set", "delete", "clear"]);
const SET_MUTATORS = new Set(["add", "delete", "clear"]);
const WRAPPERS = new Set([
  "TSNonNullExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
  "ParenthesizedExpression",
]);
const SCRIPT_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/**
 * Direct writes to `binding` in the files that import it, following unambiguous re-exports: assignments,
 * `++`/`--`, `delete`, known collection mutations, and builtin `Object.assign`, in script and in
 * `<script setup>` templates (`v-model` included). Reads, calls into the state's own methods, and
 * writes through aliases such as `const s = store` are not writes. Sorted by file, then offset.
 */
export async function findSharedStateWrites(
  ctx: RuleContext,
  graph: ImportGraph,
  binding: SharedStateBinding,
): Promise<SharedStateWrite[]> {
  const writes = new Map<string, SharedStateWrite>();
  const slots = new Map<string, ExportSlot>();
  const pending: ExportSlot[] = [];
  const exportSlot = (file: string, name: string) => {
    const key = JSON.stringify([file, name]);
    let slot = slots.get(key);
    if (!slot) {
      slots.set(key, (slot = { file, name, origins: [] }));
      pending.push(slot);
    }
    return slot;
  };
  const owner = exportSlot(binding.file, binding.exportName);
  const consumers: Array<() => Promise<SharedStateWrite[]>> = [];
  const sources = new Map<string, Promise<LoadedSource | undefined>>();
  const importers = new Map<string, Map<string, Set<string>>>();
  while (pending.length) {
    const target = pending.pop()!;
    let byImporter = importers.get(target.file);
    if (!byImporter) {
      importers.set(target.file, (byImporter = new Map()));
      for (const edge of graph.importersOf(target.file)) {
        if (edge.typeOnly || edge.kind === "dynamic-import") continue;
        let specifiers = byImporter.get(edge.from);
        if (!specifiers) byImporter.set(edge.from, (specifiers = new Set()));
        specifiers.add(edge.specifier);
      }
    }
    for (const [file, specifiers] of byImporter) {
      let loading = sources.get(file);
      if (!loading) sources.set(file, (loading = loadSource(ctx, file)));
      const source = await loading;
      if (!source) continue;
      const scan = scanImports(
        source,
        specifiers,
        target,
        binding.access === "call",
        (name, namespace) => exportSlot(file, name).origins.push({ slot: target, namespace }),
      );
      if (file !== binding.file && scan.length)
        consumers.push(() => writesInFile(ctx, source, scan, owner, binding));
    }
  }
  for (const collect of consumers)
    for (const write of await collect()) writes.set(`${write.file}:${write.range.start}`, write);
  return [...writes.values()].sort((a, b) =>
    a.file === b.file ? a.range.start - b.range.start : a.file < b.file ? -1 : 1,
  );
}

/**
 * Direct writes to `variable` inside its own module, such as the mutators that sit next to
 * exported state, including writes through `this` in the methods of a `reactive({ ... })` literal.
 */
export function findLocalStateWrites(
  ctx: RuleContext,
  file: string,
  text: string,
  scope: ScriptScope,
  variable: ScopeVariable,
  shape: SharedStateBinding["shape"],
  collectionAt: CollectionAt,
): LocalStateWrite[] {
  const parentOf = parentIndex(scope);
  const isGlobal = (id: Node) => !scope.references.get(id)?.resolved?.defs.length;
  const writes: LocalStateWrite[] = [];
  const add = (write: ClassifiedWrite | undefined) => {
    if (!write) return;
    let enclosing = parentOf(write.node);
    while (enclosing && !/Function(?:Declaration|Expression)$/.test(enclosing.type)) {
      if (enclosing.type === "PropertyDefinition" || enclosing.type === "ClassBody") return;
      enclosing = parentOf(enclosing);
    }
    writes.push({
      ...toWrite(ctx, file, text, text, 0, write, "script"),
      enclosingFunction: enclosing,
    });
  };
  for (const reference of variable.references) {
    if (reference.init) continue;
    add(classifyWrite(reference.identifier, parentOf, shape, false, collectionAt, isGlobal));
  }
  if (shape !== "reactive") return writes;
  for (const definition of variable.defs) {
    const literal = unwrap(unwrap((definition.node as Node)?.init)?.arguments?.[0]);
    if (literal?.type !== "ObjectExpression") continue;
    for (const property of literal.properties) {
      if (property.type !== "Property" || property.value?.type !== "FunctionExpression") continue;
      for (const self of thisExpressions(property.value.body, scope.visitorKeys))
        add(classifyWrite(self, parentOf, "reactive", false, collectionAt, isGlobal));
    }
  }
  return writes;
}

/** `this` in a function body, outside nested functions that rebind it. */
function thisExpressions(body: Node, keys: ScriptScope["visitorKeys"]): Node[] {
  const found: Node[] = [];
  const stack: Node[] = [body];
  while (stack.length) {
    const node = stack.pop();
    if (node.type === "ThisExpression") found.push(node);
    if (node.type === "FunctionExpression" || node.type === "FunctionDeclaration") continue;
    for (const key of keys[node.type] ?? []) {
      const value = node[key];
      for (const child of Array.isArray(value) ? value : [value])
        if (child && typeof child.type === "string") stack.push(child);
    }
  }
  return found;
}

/** The expression inside TypeScript wrappers such as `as` and `satisfies`. */
function unwrap(node: Node): Node {
  while (node && WRAPPERS.has(node.type)) node = node.expression;
  return node;
}

/** Only literal initializers and unshadowed collection constructors establish a receiver kind. */
export function stateCollections(scope: ScriptScope, initialValue: Node): CollectionAt {
  return (path) => {
    let value = unwrap(initialValue);
    for (const key of path) {
      if (key === null) return undefined;
      if (value?.type === "ArrayExpression" && /^(0|[1-9]\d*)$/.test(key)) {
        if (value.elements.some((item: Node) => item?.type === "SpreadElement")) return undefined;
        value = unwrap(value.elements[Number(key)]);
        continue;
      }
      if (value?.type !== "ObjectExpression") return undefined;
      let propertyValue: Node;
      for (const property of value.properties) {
        const name =
          property.type === "Property" ? propertyName(property.key, property.computed) : null;
        if (name === null || name === key)
          propertyValue = name !== null && property.kind === "init" ? property.value : undefined;
      }
      value = unwrap(propertyValue);
    }
    if (value?.type === "ArrayExpression") return "array";
    if (value?.type !== "NewExpression" || value.callee?.type !== "Identifier") return undefined;
    if (scope.references.get(value.callee)?.resolved?.defs.length) return undefined;
    switch (value.callee.name) {
      case "Array":
        return "array";
      case "Map":
        return "map";
      case "Set":
        return "set";
    }
  };
}

interface LoadedSource {
  file: string;
  text: string;
  script?: ScriptScope;
  setup?: ScriptScope;
  descriptor?: SFCDescriptor;
}

async function loadSource(ctx: RuleContext, file: string): Promise<LoadedSource | undefined> {
  const text = ctx.fs.readText(file);
  if (text === undefined) return undefined;
  if (file.endsWith(".vue")) {
    const { descriptor } = await parseSfcFile(file, text);
    const parseBlock = (block: SFCDescriptor["script"]) => {
      if (!block || block.src) return undefined;
      const script = createVueScriptForParsing({ script: block }, text);
      return (
        analyzeScript(script.text, script.lang === "jsx" || script.lang === "tsx" ? "tsx" : "ts") ??
        undefined
      );
    };
    return {
      file,
      text,
      script: parseBlock(descriptor.script),
      setup: parseBlock(descriptor.scriptSetup),
      descriptor,
    };
  }
  if (!SCRIPT_RE.test(file)) return undefined;
  const scope = analyzeScript(text, /\.[jt]sx$/.test(file) ? "tsx" : "ts");
  return scope ? { file, text, script: scope } : undefined;
}

interface ImportedRoot {
  variable: ScopeVariable;
  scope: ScriptScope;
  entry: Entry;
}

function scanImports(
  source: LoadedSource,
  specifiers: ReadonlySet<string>,
  slot: ExportSlot,
  call: boolean,
  forward: (name: string, namespace: boolean) => void,
): ImportedRoot[] {
  const imported: ImportedRoot[] = [];
  const { script, setup } = source;
  const scanForwarding = (id: Node, parentOf: ParentOf, namespace: boolean) => {
    const parent = parentOf(id);
    if (
      parent?.type === "ExportSpecifier" &&
      parent.local === id &&
      parent.exportKind !== "type" &&
      parentOf(parent)?.exportKind !== "type"
    )
      forward(exportedName(parent.exported), namespace);
    let outer = parent;
    while (outer && WRAPPERS.has(outer.type)) outer = parentOf(outer);
    if (outer?.type === "ExportDefaultDeclaration" && unwrap(outer.declaration) === id)
      forward("default", namespace);
  };
  for (const scope of [script, setup]) {
    if (!scope) continue;
    const parentOf = parentIndex(scope);
    const explicit = explicitExports(scope);
    const stars = (scope.ast.body as Node[]).filter(isStarExport);
    for (const statement of scope.ast.body as Node[]) {
      if (!specifiers.has(statement.source?.value)) continue;
      if (statement.type === "ImportDeclaration" && statement.importKind !== "type") {
        for (const specifier of statement.specifiers ?? []) {
          if (specifier.importKind === "type") continue;
          const namespace = specifier.type === "ImportNamespaceSpecifier";
          if (!namespace && importedName(specifier) !== slot.name) continue;
          for (const variable of scope.scopeManager.getDeclaredVariables(specifier)) {
            imported.push({ variable, scope, entry: { slot, namespace, call } });
            for (const reference of variable.references)
              scanForwarding(reference.identifier, parentOf, namespace);
            if (script && scope === setup)
              for (const id of unresolvedIds(script, variable.name))
                scanForwarding(id, parentIndex(script), namespace);
          }
        }
      } else if (statement.type === "ExportNamedDeclaration" && statement.exportKind !== "type") {
        for (const specifier of statement.specifiers ?? [])
          if (specifier.exportKind !== "type" && exportedName(specifier.local) === slot.name)
            forward(exportedName(specifier.exported), false);
      } else if (statement.type === "ExportAllDeclaration" && statement.exportKind !== "type") {
        if (statement.exported) forward(exportedName(statement.exported), true);
        else if (stars.length === 1 && slot.name !== "default" && !explicit.has(slot.name))
          forward(slot.name, false);
      }
    }
  }
  return imported;
}

function importedName(specifier: Node): string {
  return specifier.type === "ImportDefaultSpecifier" ? "default" : exportedName(specifier.imported);
}

function* unresolvedIds(scope: ScriptScope, name: string): Iterable<Node> {
  for (const reference of scope.scopeManager.globalScope?.through ?? [])
    if (reference.isValueReference && reference.identifier.name === name)
      yield reference.identifier;
}

async function writesInFile(
  ctx: RuleContext,
  source: LoadedSource,
  imported: ImportedRoot[],
  owner: ExportSlot,
  binding: SharedStateBinding,
): Promise<SharedStateWrite[]> {
  const { script, setup, text, file } = source;
  const writes: SharedStateWrite[] = [];
  const templateNames = new Map<string, Entry>();
  const scriptNames = moduleValueNames(script);
  const setupNames = moduleValueNames(setup);
  const hoistedSetupNames = new Set<string>();
  for (const statement of (setup?.ast.body ?? []) as Node[]) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
    for (const specifier of statement.specifiers ?? [])
      if (specifier.importKind !== "type") hoistedSetupNames.add(specifier.local.name);
  }
  const collectionAt = binding.collectionAt ?? (() => undefined);

  const visitReference = (id: Node, entry: Entry, scope: ScriptScope) => {
    const parentOf = parentIndex(scope);
    const match = rootFrom(id, entry, parentOf, owner);
    if (!match) return;
    const { root } = match;
    const isGlobal = (name: Node) =>
      !scope.references.get(name)?.resolved?.defs.length &&
      !(scope === setup ? scriptNames : hoistedSetupNames).has(name.name);
    const write = classifyWrite(root, parentOf, binding.shape, false, collectionAt, isGlobal);
    if (write) writes.push(toWrite(ctx, file, text, text, 0, write, "script"));
    if (!entry.call) return;
    const declarator = parentOf(root);
    if (declarator?.type !== "VariableDeclarator" || declarator.init !== root) return;
    if (declarator.id?.type !== "Identifier" || parentOf(declarator)?.kind !== "const") return;
    for (const derived of scope.scopeManager.getDeclaredVariables(declarator))
      visitRoots(derived, { call: false }, scope);
  };

  const visitRoots = (variable: ScopeVariable, entry: Entry, scope: ScriptScope) => {
    if (setup && isModuleVariable(variable)) {
      if (scope === setup || !setupNames.has(variable.name)) {
        templateNames.set(variable.name, entry);
        if (scope !== setup)
          for (const id of unresolvedIds(setup, variable.name)) visitReference(id, entry, setup);
      }
      if (script && scope === setup && hoistedSetupNames.has(variable.name))
        for (const id of unresolvedIds(script, variable.name)) visitReference(id, entry, script);
    }
    for (const reference of variable.references)
      if (!reference.init) visitReference(reference.identifier, entry, scope);
  };

  for (const { variable, entry, scope } of imported) visitRoots(variable, entry, scope);

  if (templateNames.size && source.descriptor)
    writes.push(
      ...(await templateWrites(
        ctx,
        source,
        templateNames,
        owner,
        binding.shape,
        collectionAt,
        new Set([...scriptNames, ...setupNames]),
      )),
    );
  return writes;
}

function moduleValueNames(scope: ScriptScope | undefined): Set<string> {
  return new Set(
    scope?.scopeManager.scopes.flatMap((lexical) =>
      lexical.variables
        .filter(
          (variable) =>
            isModuleVariable(variable) &&
            variable.isValueVariable &&
            variable.defs.some(
              (definition) =>
                definition.type !== "ImportBinding" ||
                ((definition.parent as Node).importKind !== "type" &&
                  (definition.node as Node).importKind !== "type"),
            ),
        )
        .map((variable) => variable.name),
    ),
  );
}

function isStarExport(statement: Node): boolean {
  return (
    statement.type === "ExportAllDeclaration" &&
    statement.exportKind !== "type" &&
    !statement.exported
  );
}

function explicitExports(scope: ScriptScope): Set<string> {
  const names = new Set<string>();
  for (const statement of scope.ast.body as Node[]) {
    if (statement.exportKind === "type") continue;
    if (statement.type === "ExportDefaultDeclaration") names.add("default");
    if (statement.type === "ExportAllDeclaration" && statement.exported)
      names.add(exportedName(statement.exported));
    if (statement.type !== "ExportNamedDeclaration") continue;
    for (const specifier of statement.specifiers ?? [])
      if (specifier.exportKind !== "type") names.add(exportedName(specifier.exported));
    const declaration = statement.declaration;
    for (const node of declaration?.type === "VariableDeclaration"
      ? declaration.declarations
      : declaration
        ? [declaration]
        : [])
      for (const variable of scope.scopeManager.getDeclaredVariables(node))
        names.add(variable.name);
    if (declaration?.id?.name) names.add(declaration.id.name);
  }
  return names;
}

async function templateWrites(
  ctx: RuleContext,
  source: LoadedSource,
  names: ReadonlyMap<string, Entry>,
  owner: ExportSlot,
  shape: SharedStateBinding["shape"],
  collectionAt: CollectionAt,
  scriptNames: ReadonlySet<string>,
): Promise<SharedStateWrite[]> {
  const template = source.descriptor?.template;
  if (!template?.ast || (template.lang && template.lang !== "html")) return [];
  const prefix = "<template>";
  const text = `${prefix}${template.content}</template>`;
  const offset = template.loc.start.offset - prefix.length;
  const [{ parseForESLint }, tsParser] = await Promise.all([
    import("vue-eslint-parser"),
    import("@typescript-eslint/parser"),
  ]);
  let root: Node;
  try {
    root = parseForESLint(text, {
      filePath: source.file,
      parser: { "<template>": tsParser },
      sourceType: "module",
      ecmaVersion: "latest",
    }).ast.templateBody;
  } catch {
    return [];
  }
  const writes: SharedStateWrite[] = [];
  const parentOf = (node: Node) => node.parent;
  const check = (ids: Node[], shadowed: ReadonlySet<string>, modelTarget?: Node) => {
    const isGlobal = (id: Node) =>
      ids.includes(id) && !shadowed.has(id.name) && !scriptNames.has(id.name);
    for (const id of ids) {
      const entry = names.get(id.name);
      if (!entry || shadowed.has(id.name)) continue;
      const match = rootFrom(id, entry, parentOf, owner);
      if (!match) continue;
      const write = classifyWrite(
        match.root,
        parentOf,
        shape,
        match.direct,
        collectionAt,
        isGlobal,
        modelTarget,
      );
      if (write)
        writes.push(toWrite(ctx, source.file, source.text, text, offset, write, "template"));
    }
  };

  const checkContainer = (node: Node, shadowed: ReadonlySet<string>, model = false) => {
    if (node?.type !== "VExpressionContainer") return;
    check(
      node.references.map((reference: Node) => reference.id),
      shadowed,
      model ? node.expression : undefined,
    );
  };
  const visit = (node: Node, shadowed: ReadonlySet<string>) => {
    if (node.type !== "VElement") {
      checkContainer(node, shadowed);
      return;
    }
    if (
      node.startTag.attributes.some((prop: Node) => prop.directive && prop.key.name.name === "pre")
    )
      return;
    const loopScope = new Set(shadowed);
    const childScope = new Set(shadowed);
    for (const variable of node.variables) {
      if (variable.kind === "v-for") loopScope.add(variable.id.name);
      childScope.add(variable.id.name);
    }
    for (const prop of node.startTag.attributes) {
      if (!prop.directive) continue;
      const name = prop.key.name.name;
      const propScope = name === "if" || name === "else-if" ? shadowed : loopScope;
      checkContainer(prop.key.argument, propScope);
      if (name === "for") {
        const right = prop.value?.expression?.right;
        if (right) check(templateExpressionReferences(right), shadowed);
      } else if (name !== "slot") {
        const eventScope = name === "on" ? new Set([...propScope, "$event"]) : propScope;
        checkContainer(prop.value, eventScope, name === "model");
      }
    }
    for (const child of node.children) visit(child, childScope);
  };
  if (root) visit(root, new Set());
  return writes;
}

function templateExpressionReferences(expression: Node): Node[] {
  const program = {
    type: "Program",
    sourceType: "module",
    range: expression.range,
    body: [{ type: "ExpressionStatement", expression, range: expression.range }],
  } as Program;
  return (analyzeScriptProgram(program, "module").globalScope?.through ?? []).map(
    (ref) => ref.identifier,
  );
}

interface ClassifiedWrite {
  kind: SharedStateWrite["kind"];
  node: Node;
  target: Node;
}

/**
 * Whether the member chain that starts at `root` is written. `unwrapped` is true in templates,
 * where a ref reads without `.value`.
 */
function classifyWrite(
  root: Node,
  parentOf: ParentOf,
  shape: SharedStateBinding["shape"],
  unwrapped: boolean,
  collectionAt: CollectionAt,
  isGlobal: IsGlobal,
  modelTarget?: Node,
): ClassifiedWrite | undefined {
  const segments: Array<string | null> = [];
  let node = root;
  let parent: Node;
  for (;;) {
    parent = parentOf(node);
    while (parent && WRAPPERS.has(parent.type)) {
      node = parent;
      parent = parentOf(node);
    }
    if (parent?.type !== "MemberExpression" || parent.object !== node) break;
    segments.push(memberName(parent));
    node = parent;
  }
  let depth = segments.length;
  if (shape === "ref" && !unwrapped) {
    if (segments[0] !== "value") return undefined;
    depth -= 1;
  }
  // A reactive object is written through its properties; a ref also through its own value.
  const writable = depth >= (shape === "reactive" ? 1 : 0);
  if (modelTarget && node === modelTarget && writable)
    return { kind: "v-model", node, target: node };
  const assignment = writable && assignmentOf(node, parentOf);
  if (assignment)
    return { kind: "assignment", node: parent === assignment ? assignment : node, target: node };
  if (parent?.type === "UpdateExpression" && parent.argument === node && writable)
    return { kind: "update", node: parent, target: node };
  if (
    parent?.type === "UnaryExpression" &&
    parent.operator === "delete" &&
    parent.argument === node &&
    depth >= 1
  )
    return { kind: "delete", node: parent, target: node };
  if (parent?.type === "CallExpression" && parent.callee === node && segments.length) {
    const method = segments.at(-1);
    if (depth >= 1 && method) {
      const collection = collectionAt(segments.slice(segments.length - depth, -1));
      if (
        (collection === "array" && ARRAY_MUTATORS.has(method)) ||
        (collection === "map" && MAP_MUTATORS.has(method)) ||
        (collection === "set" && SET_MUTATORS.has(method))
      )
        return { kind: "mutating-call", node: parent, target: unwrap(node).object };
    }
  }
  if (
    parent?.type === "CallExpression" &&
    parent.arguments[0] === node &&
    parent.arguments.length > 1 &&
    depth >= 0 &&
    isObjectAssign(parent.callee, isGlobal)
  )
    return { kind: "mutating-call", node: parent, target: node };
  return undefined;
}

function assignmentOf(node: Node, parentOf: ParentOf): Node {
  let target = node;
  for (let parent = parentOf(target); parent; parent = parentOf(target)) {
    if (
      parent.type === "AssignmentExpression" ||
      parent.type === "ForInStatement" ||
      parent.type === "ForOfStatement"
    )
      return parent.left === target ? parent : undefined;
    if (
      (parent.type === "AssignmentPattern" && parent.left === target) ||
      (parent.type === "RestElement" && parent.argument === target) ||
      (parent.type === "ArrayPattern" && parent.elements.includes(target)) ||
      (parent.type === "Property" &&
        parent.value === target &&
        parentOf(parent)?.type === "ObjectPattern") ||
      (parent.type === "ObjectPattern" && parent.properties.includes(target))
    )
      target = parent;
    else return undefined;
  }
}

/** Match export slots against the reference's actual member chain, not all possible paths. */
function rootFrom(
  id: Node,
  entry: Entry,
  parentOf: ParentOf,
  owner: ExportSlot,
): { root: Node; direct: boolean } | undefined {
  const memberOf = (node: Node, name: string): Node => {
    const parent = parentOf(node);
    if (
      parent?.type === "MemberExpression" &&
      parent.object === node &&
      memberName(parent) === name
    )
      return parent;
  };
  const finish = (node: Node) => {
    const direct = node === id;
    if (!entry.call) return { root: node, direct };
    const call = parentOf(node);
    if (call?.type === "CallExpression" && call.callee === node) return { root: call, direct };
  };
  if (!entry.slot) return finish(id);
  const first = entry.namespace ? memberOf(id, entry.slot.name) : id;
  if (!first) return undefined;
  if (entry.slot === owner) return finish(first);

  const pending = [{ slot: entry.slot, node: first }];
  const visited = new Map<Node, Set<ExportSlot>>();
  while (pending.length) {
    const { slot, node } = pending.pop()!;
    if (slot === owner) {
      const match = finish(node);
      if (match) return match;
      continue;
    }
    let slots = visited.get(node);
    if (!slots) visited.set(node, (slots = new Set()));
    if (slots.has(slot)) continue;
    slots.add(slot);
    for (const origin of slot.origins) {
      const next = origin.namespace ? memberOf(node, origin.slot.name) : node;
      if (next) pending.push({ slot: origin.slot, node: next });
    }
  }
}

function toWrite(
  ctx: RuleContext,
  file: string,
  source: string,
  parsed: string,
  offset: number,
  write: ClassifiedWrite,
  location: SharedStateWrite["in"],
): SharedStateWrite {
  const [start, end] = write.node.range as [number, number];
  const [targetStart, targetEnd] = write.target.range as [number, number];
  return {
    file,
    range: ctx.helpers.rangeFromOffsets(file, source, start + offset, end + offset),
    kind: write.kind,
    in: location,
    target: parsed.slice(targetStart, targetEnd),
  };
}

const parentIndexes = new WeakMap<ScriptScope, ParentOf>();

function parentIndex(scope: ScriptScope): ParentOf {
  let index = parentIndexes.get(scope);
  if (index) return index;
  const parents = new WeakMap<object, Node>();
  const keys = scope.visitorKeys;
  const stack: Node[] = [scope.ast];
  while (stack.length) {
    const node = stack.pop();
    for (const key of keys[node.type] ?? []) {
      const value = node[key];
      for (const child of Array.isArray(value) ? value : [value]) {
        if (!child || typeof child.type !== "string") continue;
        parents.set(child, node);
        stack.push(child);
      }
    }
  }
  index = (node) => parents.get(node);
  parentIndexes.set(scope, index);
  return index;
}

function isObjectAssign(callee: Node, isGlobal: IsGlobal): boolean {
  return (
    callee?.type === "MemberExpression" &&
    callee.object?.type === "Identifier" &&
    callee.object.name === "Object" &&
    isGlobal(callee.object) &&
    memberName(callee) === "assign"
  );
}

function memberName(node: Node): string | null {
  return propertyName(node.property, node.computed);
}

function propertyName(property: Node, computed: boolean): string | null {
  if (!computed && property?.type === "Identifier") return property.name;
  if (property?.type === "Literal" && ["string", "number"].includes(typeof property.value))
    return String(property.value);
  return null;
}

function exportedName(node: Node): string {
  return node?.type === "Identifier" ? node.name : String(node?.value);
}

function isModuleVariable(variable: ScopeVariable): boolean {
  return variable.scope.type === "module" || variable.scope.type === "global";
}
