import type { SFCDescriptor } from "@vue/compiler-sfc";
import type {
  ImportGraph,
  RuleContext,
  SourceRange,
  TemplateAstNode,
  TemplateParentNode,
} from "../primitives.js";
import { analyzeScript, type ScopeVariable, type ScriptScope } from "./script-scope.js";
import { createVueScriptForParsing, parseSfcFile } from "./sfc.js";
import { TemplateNodeType, templateDirectiveBindings } from "./template.js";

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

type Node = any;
type ParentOf = (node: Node) => Node;

/** How a reference reaches the state: through a namespace member, a call, or both. */
interface Entry {
  member?: string;
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
const COLLECTION_MUTATORS = new Set(["set", "add", "delete", "clear"]);
const WRAPPERS = new Set([
  "TSNonNullExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
  "ParenthesizedExpression",
]);
const SCRIPT_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/**
 * Every direct write to `binding` in the files that import it, following re-exports: assignments,
 * `++`/`--`, `delete`, mutating array, Map and Set methods, and `Object.assign`, in script and in
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
  const pending: Array<{ file: string; exportName: string }> = [
    { file: binding.file, exportName: binding.exportName },
  ];
  while (pending.length) {
    const target = pending.pop()!;
    const key = `${target.file}\0${target.exportName}`;
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
      const source = await loadSource(ctx, file);
      if (!source) continue;
      const found = writesInFile(ctx, source, specifiers, target.exportName, binding);
      for (const write of found.writes) writes.set(`${write.file}:${write.range.start}`, write);
      for (const exportName of found.reExports) pending.push({ file, exportName });
    }
  }
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
): SharedStateWrite[] {
  const parentOf = parentIndex(scope);
  const writes: SharedStateWrite[] = [];
  const add = (write: ClassifiedWrite | undefined) => {
    if (write) writes.push(toWrite(ctx, file, text, text, 0, write, "script"));
  };
  for (const reference of variable.references) {
    if (reference.init) continue;
    add(classifyWrite(reference.identifier, parentOf, shape, false));
  }
  if (shape !== "reactive") return writes;
  for (const definition of variable.defs) {
    const literal = unwrap((definition.node as Node)?.init)?.arguments?.[0];
    if (literal?.type !== "ObjectExpression") continue;
    for (const property of literal.properties) {
      if (property.type !== "Property" || property.value?.type !== "FunctionExpression") continue;
      for (const self of thisExpressions(property.value.body, scope.visitorKeys))
        add(classifyWrite(self, parentOf, "reactive", false));
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

interface LoadedSource {
  file: string;
  text: string;
  scope: ScriptScope;
  /** With `<script setup>`, top-level bindings of both script blocks reach the template. */
  templateSeesScript: boolean;
  descriptor?: SFCDescriptor;
}

async function loadSource(ctx: RuleContext, file: string): Promise<LoadedSource | undefined> {
  const text = ctx.fs.readText(file);
  if (text === undefined) return undefined;
  if (file.endsWith(".vue")) {
    const { descriptor } = await parseSfcFile(file, text);
    const script = createVueScriptForParsing(descriptor, text);
    const scope = analyzeScript(
      script.text,
      script.lang === "jsx" || script.lang === "tsx" ? "tsx" : "ts",
    );
    if (!scope) return undefined;
    return {
      file,
      text,
      scope,
      descriptor,
      templateSeesScript: !!descriptor.scriptSetup,
    };
  }
  if (!SCRIPT_RE.test(file)) return undefined;
  const scope = analyzeScript(text, /\.[jt]sx$/.test(file) ? "tsx" : "ts");
  return scope ? { file, text, scope, templateSeesScript: false } : undefined;
}

function writesInFile(
  ctx: RuleContext,
  source: LoadedSource,
  specifiers: ReadonlySet<string>,
  exportName: string,
  binding: SharedStateBinding,
): { writes: SharedStateWrite[]; reExports: string[] } {
  const { scope, text, file } = source;
  const parentOf = parentIndex(scope);
  const writes: SharedStateWrite[] = [];
  const reExports: string[] = [];
  const templateNames = new Map<string, Entry>();
  const call = binding.access === "call";

  const visitRoots = (variable: ScopeVariable, entry: Entry, reachesTemplate: boolean) => {
    if (reachesTemplate && isModuleVariable(variable)) templateNames.set(variable.name, entry);
    for (const reference of variable.references) {
      if (reference.init) continue;
      const id = reference.identifier as Node;
      const parent = parentOf(id);
      if (
        parent?.type === "ExportSpecifier" &&
        parent.local === id &&
        !entry.member &&
        !entry.call
      ) {
        reExports.push(exportedName(parent.exported));
        continue;
      }
      const root = rootFrom(id, entry, parentOf);
      if (!root) continue;
      const write = classifyWrite(root, parentOf, binding.shape, false);
      if (write) writes.push(toWrite(ctx, file, text, text, 0, write, "script"));
      if (!entry.call) continue;
      // `const store = useStore()` makes `store` a root of its own.
      const declarator = parentOf(root);
      if (declarator?.type !== "VariableDeclarator" || declarator.init !== root) continue;
      if (declarator.id?.type !== "Identifier") continue;
      for (const derived of scope.scopeManager.getDeclaredVariables(declarator))
        visitRoots(derived, { call: false }, reachesTemplate);
    }
  };

  for (const statement of scope.ast.body as Node[]) {
    if (!specifiers.has(statement.source?.value)) continue;
    if (statement.type === "ImportDeclaration" && statement.importKind !== "type") {
      const reachesTemplate = source.templateSeesScript;
      for (const specifier of statement.specifiers ?? []) {
        if (specifier.importKind === "type") continue;
        let entry: Entry | undefined;
        if (specifier.type === "ImportNamespaceSpecifier") entry = { member: exportName, call };
        else if (specifier.type === "ImportDefaultSpecifier")
          entry = exportName === "default" ? { call } : undefined;
        else if (exportedName(specifier.imported) === exportName) entry = { call };
        if (!entry) continue;
        for (const variable of scope.scopeManager.getDeclaredVariables(specifier))
          visitRoots(variable, entry, reachesTemplate);
      }
    } else if (statement.type === "ExportNamedDeclaration" && statement.exportKind !== "type") {
      for (const specifier of statement.specifiers ?? []) {
        if (specifier.exportKind !== "type" && exportedName(specifier.local) === exportName)
          reExports.push(exportedName(specifier.exported));
      }
    } else if (
      statement.type === "ExportAllDeclaration" &&
      statement.exportKind !== "type" &&
      !statement.exported &&
      exportName !== "default"
    ) {
      reExports.push(exportName);
    }
  }

  if (templateNames.size && source.descriptor)
    writes.push(...templateWrites(ctx, source, templateNames, binding.shape));
  return { writes, reExports };
}

function templateWrites(
  ctx: RuleContext,
  source: LoadedSource,
  names: ReadonlyMap<string, Entry>,
  shape: SharedStateBinding["shape"],
): SharedStateWrite[] {
  const template = source.descriptor?.template;
  if (!template?.ast || (template.lang && template.lang !== "html")) return [];
  const writes: SharedStateWrite[] = [];
  const mention = new RegExp(
    `(?<![\\w$.])(?:${[...names.keys()].map(escape).join("|")})(?![\\w$])`,
  );

  const visit = (node: TemplateAstNode, shadowed: ReadonlySet<string>) => {
    if (node.type === TemplateNodeType.INTERPOLATION) {
      check(node.content as Node, shadowed, false);
      return;
    }
    if (node.type !== TemplateNodeType.ELEMENT) {
      if (node.type === TemplateNodeType.ROOT)
        for (const child of node.children) visit(child, shadowed);
      return;
    }
    let inner = shadowed;
    for (const prop of node.props) {
      if (prop.type !== TemplateNodeType.DIRECTIVE) continue;
      if (prop.name !== "for" && prop.name !== "slot") continue;
      inner = new Set([...inner, ...templateDirectiveBindings(prop)]);
    }
    for (const prop of node.props) {
      if (prop.type !== TemplateNodeType.DIRECTIVE || prop.name === "for" || prop.name === "slot")
        continue;
      if (prop.exp) check(prop.exp as Node, inner, prop.name === "model");
    }
    for (const child of node.children) visit(child as TemplateParentNode, inner);
  };

  const check = (expression: Node, shadowed: ReadonlySet<string>, model: boolean) => {
    const content: string = expression?.content ?? "";
    if (expression?.isStatic || !mention.test(content)) return;
    const index = expression.loc.source.indexOf(content);
    const base = expression.loc.start.offset + Math.max(index, 0);
    let text = `(${content})`;
    let offset = base - 1;
    let scope = analyzeScript(text, "ts");
    if (!scope) {
      text = content;
      offset = base;
      scope = analyzeScript(text, "ts");
    }
    if (!scope) return;
    const parentOf = parentIndex(scope);
    const modelTarget = model ? (scope.ast.body[0]?.expression as Node) : undefined;
    for (const reference of scope.scopeManager.globalScope?.through ?? []) {
      const id = reference.identifier as Node;
      const entry = names.get(id.name);
      if (!entry || shadowed.has(id.name)) continue;
      const root = rootFrom(id, entry, parentOf);
      if (!root) continue;
      const write = classifyWrite(root, parentOf, shape, true, modelTarget);
      if (write)
        writes.push(toWrite(ctx, source.file, source.text, text, offset, write, "template"));
    }
  };

  visit(template.ast as TemplateAstNode, new Set());
  return writes;
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
  if (parent?.type === "AssignmentExpression" && parent.left === node && writable)
    return { kind: "assignment", node: parent, target: node };
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
    const receiverDepth = depth - 1;
    if (receiverDepth < 0 || !method) return undefined;
    // `store.add()` may be the store's own action; a nested `store.tags.add()` is a Set.
    const minimum = COLLECTION_MUTATORS.has(method) && shape === "reactive" ? 1 : 0;
    if ((ARRAY_MUTATORS.has(method) || COLLECTION_MUTATORS.has(method)) && receiverDepth >= minimum)
      return { kind: "mutating-call", node: parent, target: node.object };
  }
  if (
    parent?.type === "CallExpression" &&
    parent.arguments[0] === node &&
    depth >= 0 &&
    isObjectAssign(parent.callee)
  )
    return { kind: "mutating-call", node: parent, target: node };
  return undefined;
}

/** The node a reference reaches the state through: the identifier, `ns.state`, or `useStore()`. */
function rootFrom(id: Node, entry: Entry, parentOf: ParentOf): Node {
  let root = id;
  if (entry.member) {
    const parent = parentOf(root);
    if (parent?.type !== "MemberExpression" || parent.object !== root) return undefined;
    if (memberName(parent) !== entry.member) return undefined;
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

function isObjectAssign(callee: Node): boolean {
  return (
    callee?.type === "MemberExpression" &&
    callee.object?.type === "Identifier" &&
    callee.object.name === "Object" &&
    memberName(callee) === "assign"
  );
}

function memberName(node: Node): string | null {
  const property = node.property;
  if (!node.computed && property?.type === "Identifier") return property.name;
  if (property?.type === "Literal" && typeof property.value === "string") return property.value;
  return null;
}

function exportedName(node: Node): string {
  return node?.type === "Identifier" ? node.name : String(node?.value);
}

function isModuleVariable(variable: ScopeVariable): boolean {
  return variable.scope.type === "module" || variable.scope.type === "global";
}

function escape(name: string): string {
  return name.replace(/[$]/g, "\\$");
}
