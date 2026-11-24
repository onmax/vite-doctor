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
  /**
   * Public names that may reach this binding, and the evidence for each reference kind.
   * An explicit `#imports` specifier is independent of Nuxt's implicit transform.
   */
  autoImports?: {
    names: (file: string) => Iterable<string>;
    resolve: (
      file: string,
      name: string,
      kind: "implicit" | "explicit",
    ) => "resolved" | "by-name" | undefined;
  };
}

export interface SharedStateWrite {
  /** The writing file, as an absolute path. */
  file: string;
  range: SourceRange;
  kind: "assignment" | "update" | "delete" | "mutating-call" | "v-model";
  in: "script" | "template";
  /** The written expression as source text, such as `store.count` or `items.value`. */
  target: string;
  /** The written property path relative to the unwrapped state; `null` marks a computed key. */
  path: PropertyPath;
  /** Known source keys of a root Object.assign write, kept together at one location. */
  assignedKeys?: readonly string[];
  byName?: boolean;
}

export interface LocalStateWrite extends SharedStateWrite {
  enclosingFunction?: Node;
}

type Node = any;
type ParentOf = (node: Node) => Node;
export type PropertyPath = readonly (string | null)[];
type CollectionAt = (path: PropertyPath) => "array" | "map" | "set" | undefined;
type IsGlobal = (id: Node) => boolean;

/** How a reference reaches the state: through a namespace member, a call, or both. */
interface Entry {
  members: readonly string[];
  call: boolean;
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
const NUXT_IMPORTS = "#imports";

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
  const visited = new Set<string>();
  const pending: Array<{ file: string; path: readonly string[]; history: ReadonlySet<string> }> = [
    { file: binding.file, path: [binding.exportName], history: new Set([binding.file]) },
  ];
  const sources = new Map<string, Promise<LoadedSource | undefined>>();
  while (pending.length) {
    const target = pending.pop()!;
    const key = JSON.stringify([target.file, target.path]);
    if (visited.has(key)) continue;
    visited.add(key);
    const byImporter = new Map<string, Set<string>>();
    for (const edge of graph.importersOf(target.file)) {
      if (edge.typeOnly || edge.kind === "dynamic-import" || edge.from === binding.file) continue;
      let specifiers = byImporter.get(edge.from);
      if (!specifiers) byImporter.set(edge.from, (specifiers = new Set()));
      specifiers.add(edge.specifier);
    }
    for (const [file, specifiers] of byImporter) {
      let loading = sources.get(file);
      if (!loading) sources.set(file, (loading = loadSource(ctx, file)));
      const source = await loading;
      if (!source) continue;
      const found = await writesInFile(ctx, source, specifiers, target.path, binding);
      for (const write of found.writes) writes.set(`${write.file}:${write.range.start}`, write);
      if (!target.history.has(file)) {
        const history = new Set([...target.history, file]);
        for (const path of found.reExports) pending.push({ file, path, history });
      }
    }
  }
  const autoImports = binding.autoImports;
  if (autoImports) {
    for (const file of graph.files) {
      if (file === binding.file) continue;
      const candidates = [...autoImports.names(file)];
      if (!candidates.length) continue;
      const text = ctx.fs.readText(file);
      const names = candidates.filter((name) => text?.includes(name));
      if (!names.length) continue;
      let loading = sources.get(file);
      if (!loading) sources.set(file, (loading = loadSource(ctx, file)));
      const source = await loading;
      if (!source) continue;
      for (const name of names) {
        const implicit =
          usesAutoImport(source, name, "implicit") && autoImports.resolve(file, name, "implicit");
        const explicit =
          usesAutoImport(source, name, "explicit") && autoImports.resolve(file, name, "explicit");
        if (!implicit && !explicit) continue;
        const found = await writesInFile(
          ctx,
          source,
          new Set(explicit ? [NUXT_IMPORTS] : []),
          [name],
          binding,
          Boolean(implicit),
        );
        for (const write of found.writes) {
          const key = `${write.file}:${write.range.start}`;
          if (implicit === "by-name") {
            if (!writes.has(key)) writes.set(key, { ...write, byName: true });
          } else writes.set(key, write);
        }
      }
    }
  }
  return [...writes.values()].sort((a, b) =>
    a.file === b.file ? a.range.start - b.range.start : a.file < b.file ? -1 : 1,
  );
}

/** Whether `source` reaches `name` with no import or declaration, or imports it from `#imports`. */
function usesAutoImport(
  source: LoadedSource,
  name: string,
  kind: "implicit" | "explicit",
): boolean {
  return [source.script, source.setup].some((scope) =>
    kind === "implicit"
      ? scope?.scopeManager.globalScope?.through.some(
          (reference) => reference.identifier.name === name && reference.isValueReference,
        )
      : (scope?.ast.body as Node[] | undefined)?.some(
          (statement) =>
            statement.type === "ImportDeclaration" &&
            statement.importKind !== "type" &&
            statement.source.value === NUXT_IMPORTS &&
            statement.specifiers.some(
              (specifier: Node) =>
                specifier.importKind !== "type" &&
                (specifier.type === "ImportNamespaceSpecifier" ||
                  (specifier.type === "ImportSpecifier" &&
                    exportedName(specifier.imported) === name)),
            ),
        ),
  );
}

/** Direct writes through `this` in `fn`, outside nested functions that rebind it. */
export function findThisWrites(
  ctx: RuleContext,
  file: string,
  text: string,
  scope: ScriptScope,
  fn: Node,
  collectionAt: CollectionAt,
): SharedStateWrite[] {
  const parentOf = parentIndex(scope);
  const isGlobal = (id: Node) => !scope.references.get(id)?.resolved?.defs.length;
  return thisExpressions(fn.body, scope.visitorKeys).flatMap((self) => {
    const write = classifyWrite(self, parentOf, "reactive", false, collectionAt, isGlobal);
    return write ? [toWrite(ctx, file, text, text, 0, write, "script")] : [];
  });
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
    if (rebindsThis(node)) continue;
    for (const key of keys[node.type] ?? []) {
      const value = node[key];
      for (const child of Array.isArray(value) ? value : [value])
        if (child && typeof child.type === "string") stack.push(child);
    }
  }
  return found;
}

export function rebindsThis(node: Node): boolean {
  return (
    node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration" ||
    node.type === "ClassBody"
  );
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

async function writesInFile(
  ctx: RuleContext,
  source: LoadedSource,
  specifiers: ReadonlySet<string>,
  [exportName, ...members]: readonly string[],
  binding: SharedStateBinding,
  autoImported = false,
): Promise<{ writes: SharedStateWrite[]; reExports: string[][] }> {
  const { script, setup, text, file } = source;
  const writes: SharedStateWrite[] = [];
  const reExports: string[][] = [];
  const templateNames = new Map<string, Entry>();
  const call = binding.access === "call";
  const scriptNames = moduleValueNames(script);
  const setupNames = moduleValueNames(setup);
  const collectionAt = binding.collectionAt ?? (() => undefined);

  const visitReference = (id: Node, entry: Entry, scope: ScriptScope) => {
    const parentOf = parentIndex(scope);
    const parent = parentOf(id);
    if (
      parent?.type === "ExportSpecifier" &&
      parent.local === id &&
      parent.exportKind !== "type" &&
      parentOf(parent)?.exportKind !== "type"
    ) {
      reExports.push([exportedName(parent.exported), ...entry.members]);
      return;
    }
    let outer = parent;
    while (outer && WRAPPERS.has(outer.type)) outer = parentOf(outer);
    if (outer?.type === "ExportDefaultDeclaration" && unwrap(outer.declaration) === id)
      reExports.push(["default", ...entry.members]);
    const root = rootFrom(id, entry, parentOf);
    if (!root) return;
    const isGlobal = (name: Node) =>
      !scope.references.get(name)?.resolved?.defs.length &&
      (scope !== setup || !scriptNames.has(name.name));
    const write = classifyWrite(root, parentOf, binding.shape, false, collectionAt, isGlobal);
    if (write) writes.push(toWrite(ctx, file, text, text, 0, write, "script"));
    if (!entry.call) return;
    const declarator = parentOf(root);
    if (declarator?.type !== "VariableDeclarator" || declarator.init !== root) return;
    if (declarator.id?.type !== "Identifier" || parentOf(declarator)?.kind !== "const") return;
    for (const derived of scope.scopeManager.getDeclaredVariables(declarator))
      visitRoots(derived, { members: [], call: false }, scope);
  };

  const visitRoots = (variable: ScopeVariable, entry: Entry, scope: ScriptScope) => {
    if (
      setup &&
      isModuleVariable(variable) &&
      (scope === setup || !setupNames.has(variable.name))
    ) {
      templateNames.set(variable.name, entry);
      if (scope !== setup) {
        for (const reference of setup.scopeManager.globalScope?.through ?? [])
          if (reference.identifier.name === variable.name)
            visitReference(reference.identifier, entry, setup);
      }
    }
    for (const reference of variable.references)
      if (!reference.init) visitReference(reference.identifier, entry, scope);
  };

  if (autoImported) {
    for (const scope of [script, setup]) {
      for (const reference of scope?.scopeManager.globalScope?.through ?? []) {
        if (reference.identifier.name !== exportName || !reference.isValueReference) continue;
        if (scope === setup && scriptNames.has(exportName)) continue;
        visitReference(reference.identifier, { members, call }, scope!);
      }
    }
  }

  for (const scope of [script, setup]) {
    if (!scope) continue;
    const explicit = explicitExports(scope);
    const stars = (scope.ast.body as Node[]).filter(isStarExport);
    for (const statement of scope.ast.body as Node[]) {
      if (!specifiers.has(statement.source?.value)) continue;
      if (statement.type === "ImportDeclaration" && statement.importKind !== "type") {
        for (const specifier of statement.specifiers ?? []) {
          if (specifier.importKind === "type") continue;
          let entry: Entry | undefined;
          if (specifier.type === "ImportNamespaceSpecifier")
            entry = { members: [exportName!, ...members], call };
          else if (specifier.type === "ImportDefaultSpecifier")
            entry = exportName === "default" ? { members, call } : undefined;
          else if (exportedName(specifier.imported) === exportName) entry = { members, call };
          if (!entry) continue;
          for (const variable of scope.scopeManager.getDeclaredVariables(specifier))
            visitRoots(variable, entry, scope);
        }
      } else if (statement.type === "ExportNamedDeclaration" && statement.exportKind !== "type") {
        for (const specifier of statement.specifiers ?? []) {
          if (specifier.exportKind !== "type" && exportedName(specifier.local) === exportName)
            reExports.push([exportedName(specifier.exported), ...members]);
        }
      } else if (statement.type === "ExportAllDeclaration" && statement.exportKind !== "type") {
        if (statement.exported)
          reExports.push([exportedName(statement.exported), exportName!, ...members]);
        else if (stars.length === 1 && exportName !== "default" && !explicit.has(exportName!))
          reExports.push([exportName!, ...members]);
      }
    }
  }

  if (templateNames.size && source.descriptor)
    writes.push(
      ...(await templateWrites(
        ctx,
        source,
        templateNames,
        binding.shape,
        collectionAt,
        new Set([...scriptNames, ...setupNames]),
      )),
    );
  return { writes, reExports };
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
  const check = (ids: Node[], expression: Node, shadowed: ReadonlySet<string>, model: boolean) => {
    let globals: Set<Node> | undefined;
    const isGlobal = (id: Node) => {
      if (shadowed.has(id.name) || scriptNames.has(id.name)) return false;
      globals ??= templateGlobals(expression);
      return globals.has(id);
    };
    for (const id of ids) {
      const entry = names.get(id.name);
      if (!entry || shadowed.has(id.name)) continue;
      const root = rootFrom(id, entry, parentOf);
      if (!root) continue;
      const write = classifyWrite(
        root,
        parentOf,
        shape,
        entry.members.length === 0,
        collectionAt,
        isGlobal,
        model ? expression : undefined,
      );
      if (write)
        writes.push(toWrite(ctx, source.file, source.text, text, offset, write, "template"));
    }
  };

  const checkContainer = (node: Node, shadowed: ReadonlySet<string>, model = false) => {
    if (node?.type !== "VExpressionContainer") return;
    check(
      node.references.map((reference: Node) => reference.id),
      node.expression,
      shadowed,
      model,
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
        if (right) check(templateExpressionReferences(right), right, shadowed, false);
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

function templateGlobals(expression: Node): Set<Node> {
  if (!expression || (expression.type.startsWith("V") && expression.type !== "VOnExpression"))
    return new Set();
  const program: Node = {
    type: "Program",
    range: expression.range,
    sourceType: "module",
    body:
      expression.type === "VOnExpression"
        ? expression.body
        : [{ type: "ExpressionStatement", range: expression.range, expression }],
  };
  const scope = analyzeScriptProgram(program, "module");
  return new Set(
    scope.scopes.flatMap((scope) =>
      scope.references
        .filter((reference) => !reference.resolved?.defs.length)
        .map((reference) => reference.identifier),
    ),
  );
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
  path: PropertyPath;
  assignedKeys?: readonly string[];
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
  const path = segments.slice(segments.length - depth);
  if (modelTarget && node === modelTarget && writable)
    return { kind: "v-model", node, target: node, path };
  const assignment = writable && assignmentOf(node, parentOf);
  if (assignment)
    return {
      kind: "assignment",
      node: parent === assignment ? assignment : node,
      target: node,
      path,
    };
  if (parent?.type === "UpdateExpression" && parent.argument === node && writable)
    return { kind: "update", node: parent, target: node, path };
  if (
    parent?.type === "UnaryExpression" &&
    parent.operator === "delete" &&
    parent.argument === node &&
    depth >= 1
  )
    return { kind: "delete", node: parent, target: node, path };
  if (parent?.type === "CallExpression" && parent.callee === node && segments.length) {
    const method = segments.at(-1);
    if (depth >= 1 && method) {
      const collection = collectionAt(segments.slice(segments.length - depth, -1));
      if (
        (collection === "array" && ARRAY_MUTATORS.has(method)) ||
        (collection === "map" && MAP_MUTATORS.has(method)) ||
        (collection === "set" && SET_MUTATORS.has(method))
      )
        return {
          kind: "mutating-call",
          node: parent,
          target: unwrap(node).object,
          path: path.slice(0, -1),
        };
    }
  }
  if (
    parent?.type === "CallExpression" &&
    parent.arguments[0] === node &&
    parent.arguments.length > 1 &&
    depth >= 0 &&
    isObjectAssign(parent.callee, isGlobal)
  )
    return {
      kind: "mutating-call",
      node: parent,
      target: node,
      path,
      assignedKeys: path.length
        ? undefined
        : [...new Set((parent.arguments as Node[]).slice(1).flatMap(objectLiteralKeys))],
    };
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

/** The node a reference reaches the state through: the identifier, `ns.state`, or `useStore()`. */
function rootFrom(id: Node, entry: Entry, parentOf: ParentOf): Node {
  let root = id;
  for (const member of entry.members) {
    const parent = parentOf(root);
    if (parent?.type !== "MemberExpression" || parent.object !== root) return undefined;
    if (memberName(parent) !== member) return undefined;
    root = parent;
  }
  if (entry.call) {
    const parent = parentOf(root);
    if (parent?.type !== "CallExpression" || parent.callee !== root) return undefined;
    root = parent;
  }
  return root;
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
    path: write.path,
    ...(write.assignedKeys?.length && { assignedKeys: write.assignedKeys }),
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

function objectLiteralKeys(node: Node): string[] {
  const object = unwrap(node);
  if (object?.type !== "ObjectExpression") return [];
  return object.properties.flatMap((property: Node) => {
    if (property.type === "SpreadElement") return objectLiteralKeys(property.argument);
    const name = ownPropertyName(property);
    return name === null ? [] : [name];
  });
}

export function ownPropertyName(property: Node): string | null {
  if (property.type !== "Property") return null;
  const name = propertyName(property.key, property.computed);
  if (
    name === "__proto__" &&
    !property.computed &&
    !property.method &&
    !property.shorthand &&
    property.kind === "init"
  )
    return null;
  return name;
}

function exportedName(node: Node): string {
  return node?.type === "Identifier" ? node.name : String(node?.value);
}

function isModuleVariable(variable: ScopeVariable): boolean {
  return variable.scope.type === "module" || variable.scope.type === "global";
}
