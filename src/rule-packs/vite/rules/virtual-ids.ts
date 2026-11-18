import { dirname, relative, resolve } from "pathe";
import { createRule, type RuleContext, type SourceRange } from "../../../core/index.js";
import { parseScript } from "../../../core/internal/script.js";
import { parseSfcFile, parseVueScripts } from "../../../core/internal/sfc.js";
// oxlint-disable-next-line no-restricted-imports -- walks the project tree, so the Rule declares cacheScope "none".
import { selectScanFiles } from "../../../core/internal/source-inventory.js";
import { diagnostics } from "../../../diagnostics.js";
import { propertyName, SOURCE_EXCLUDE, type AnyNode } from "./shared.js";

const RULE_ID = "vite/plugin/no-fragment-in-virtual-id";
const UNKNOWN = Symbol("unknown");
type Value = string | number | boolean | null | undefined | RegExp | Value[] | typeof UNKNOWN;

const scriptExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
// An import whose specifier holds "#": the only imports whose resolved id can carry one by convention.
const hashImportRe = /(?:\bfrom|\bimport)\s*\(?\s*["'`][^"'`\n]*#[^"'`\n]*["'`]/;
// Conditions that can keep a resolveId branch away from the browser.
const environmentGateRe = /\bssr\b|environment|consumer/i;
const typeWrappers = new Set([
  "TSAsExpression",
  "TSTypeAssertion",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "ParenthesizedExpression",
]);

export const noFragmentInVirtualId = createRule({
  meta: {
    id: RULE_ID,
    title: "Keep # out of virtual module ids the browser loads",
    category: "plugins",
    severity: "error",
    confidence: "heuristic-high",
    docsUrl: "https://vite.dev/guide/api-plugin.html#virtual-modules-convention",
    execution: "workspace",
    activationScope: "workspace",
    cacheScope: "none",
    requires: { crossFile: true },
    requiresContext: ["cross-file"],
    consumesEvidence: ["ast"],
    cost: "medium",
  },
  create(ctx) {
    return {
      async onWorkspaceEnd() {
        const files = (await selectScanFiles(ctx.project.root, {}, {}, ctx.project)).filter(
          (entry) => entry.sourceKind !== "module",
        );
        const modules = new ModuleReader(ctx);
        const hooks: ResolveIdHook[] = [];
        for (const entry of files) {
          if (entry.path.endsWith(".vue")) continue;
          const text = ctx.fs.readText(entry.path);
          if (!text?.includes("resolveId")) continue;
          const module = modules.read(entry.path);
          if (module) hooks.push(...findResolveIdHooks(module));
        }
        if (!hooks.length) return;
        const importers = await findBrowserImports(ctx, files, modules);
        if (!importers.length) return;

        const findings = new Map<string, Finding>();
        for (const hook of hooks) {
          for (const imported of importers) {
            for (const resolved of resolveSpecifier(hook, imported.specifier, modules)) {
              if (typeof resolved.value !== "string" || !resolved.value.includes("#")) continue;
              const site = reportSite(hook.module, resolved.node);
              const key = `${hook.module.path}\0${site.start}\0${resolved.value}`;
              const finding = findings.get(key) ?? {
                file: hook.module.path,
                range: ctx.helpers.rangeFromOffsets(
                  hook.module.path,
                  hook.module.text,
                  site.start,
                  site.end,
                ),
                id: resolved.value,
                specifier: imported.specifier,
                importers: [],
              };
              if (!finding.importers.some((item) => item.file === imported.file))
                finding.importers.push(imported);
              findings.set(key, finding);
            }
          }
        }
        for (const finding of findings.values()) report(ctx, finding);
      },
    };
  },
});

interface Finding {
  file: string;
  range: SourceRange;
  id: string;
  specifier: string;
  importers: BrowserImport[];
}

interface BrowserImport {
  file: string;
  specifier: string;
  range: SourceRange;
  evidence: string;
}

function report(ctx: RuleContext, finding: Finding) {
  const url = `/@id/${finding.id.replace("\0", "__x00__")}`;
  const requested = url.slice(0, url.indexOf("#"));
  const [first] = finding.importers;
  const where = `${displayPath(ctx, first!.file)}:${first!.range.line}`;
  ctx.report(
    diagnostics.VITE0028({
      why: `This resolveId hook resolves "${finding.specifier}" to ${printId(finding.id)}, and ${where} imports it in browser code (${first!.evidence}). The Vite dev server serves that module at "${url}", but the browser treats everything after "#" as a URL fragment and requests "${requested}", so the import fails and the page does not load.`,
      fix: `Resolve "${finding.specifier}" to an id without "#", such as ${printId(suggestedId(finding.id))}, and update the load hook and any filter that matches the old id. Keep "${finding.specifier}" as the import specifier.`,
      sources: finding.importers.map((item) => `${displayPath(ctx, item.file)}:${item.range.line}`),
    }),
    {
      ruleId: RULE_ID,
      severity: ctx.severity,
      category: "plugins",
      file: finding.file,
      range: finding.range,
      related: finding.importers.map((item) => ({
        file: item.file,
        range: item.range,
        message: `Imports "${item.specifier}" in browser code (${item.evidence})`,
      })),
      evidence: [
        {
          kind: "ast",
          file: finding.file,
          range: finding.range,
          summary: `resolveId returns ${printId(finding.id)} for "${finding.specifier}".`,
        },
        ...finding.importers.map((item) => ({
          kind: "ast" as const,
          file: item.file,
          range: item.range,
          summary: `Browser code imports "${item.specifier}": ${item.evidence}.`,
        })),
      ],
    },
  );
}

function displayPath(ctx: RuleContext, file: string): string {
  return relative(ctx.project.root, file);
}

function printId(id: string): string {
  return `"${id.replace("\0", "\\0")}"`;
}

function suggestedId(id: string): string {
  const virtual = id.replace(/^\0#/, "\0virtual:").replace(/^#/, "virtual:");
  return virtual.replaceAll("#", "/");
}

interface ParsedModule {
  path: string;
  text: string;
  program: AnyNode;
  consts: Map<string, AnyNode>;
  imports: Map<string, { source: string; imported: string }>;
  exports: Map<string, { local?: string; source?: string; imported?: string }>;
  starExports: string[];
}

class ModuleReader {
  private readonly modules = new Map<string, ParsedModule | null>();
  private readonly ctx: RuleContext;
  constructor(ctx: RuleContext) {
    this.ctx = ctx;
  }

  read(path: string): ParsedModule | null {
    if (this.modules.has(path)) return this.modules.get(path)!;
    this.modules.set(path, null);
    const text = this.ctx.fs.readText(path);
    const program = text === undefined ? null : parseScript(path, text);
    const module = program ? describeModule(path, text!, program) : null;
    this.modules.set(path, module);
    return module;
  }

  resolveImport(from: string, source: string): string | undefined {
    if (source.startsWith(".")) return this.firstFile(resolve(dirname(from), source));
    const owner = (this.ctx.project.workspacePackages ?? [])
      .filter((item) => item.name && (source === item.name || source.startsWith(`${item.name}/`)))
      .sort((left, right) => right.name!.length - left.name!.length)[0];
    if (!owner) return undefined;
    const packageRoot = resolve(this.ctx.project.root, owner.root);
    const subpath = `.${source.slice(owner.name!.length)}`;
    const manifest = this.ctx.fs.readJson(resolve(packageRoot, "package.json")) as
      | { exports?: unknown }
      | undefined;
    const targets = exportTargets(manifest?.exports, subpath);
    if (subpath === ".") targets.push("./src/index.ts");
    else targets.push(`./src/${subpath.slice(2)}`);
    for (const target of targets) {
      const clean = target.replace(/^\.\//, "");
      const source = clean.replace(/^dist\//, "src/").replace(/(?:\.d)?\.[cm]?[jt]s$/, "");
      const file =
        this.firstFile(resolve(packageRoot, source)) ?? this.firstFile(resolve(packageRoot, clean));
      if (file) return file;
    }
    return undefined;
  }

  private firstFile(base: string): string | undefined {
    const stripped = base.replace(/\.[cm]?js$/, "");
    const candidates = [
      base,
      ...scriptExtensions.map((extension) => `${stripped}${extension}`),
      ...scriptExtensions.map((extension) => `${base}/index${extension}`),
    ];
    return candidates.find((file) => this.ctx.fs.stat(file)?.isFile());
  }
}

function exportTargets(exports: unknown, subpath: string): string[] {
  const entry =
    typeof exports === "string" || Array.isArray(exports)
      ? subpath === "."
        ? exports
        : undefined
      : exports && typeof exports === "object"
        ? Object.keys(exports).some((key) => key.startsWith("."))
          ? (exports as Record<string, unknown>)[subpath]
          : subpath === "."
            ? exports
            : undefined
        : undefined;
  const targets: string[] = [];
  const collect = (value: unknown) => {
    if (typeof value === "string") targets.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(entry);
  return targets;
}

function describeModule(path: string, text: string, program: AnyNode): ParsedModule {
  const module: ParsedModule = {
    path,
    text,
    program,
    consts: new Map(),
    imports: new Map(),
    exports: new Map(),
    starExports: [],
  };
  for (const statement of program.body ?? []) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "VariableDeclaration" && declaration.kind === "const") {
      for (const item of declaration.declarations) {
        if (item.id.type !== "Identifier" || !item.init) continue;
        module.consts.set(item.id.name, item);
        if (declaration !== statement) module.exports.set(item.id.name, { local: item.id.name });
      }
    }
    if (statement.type === "ImportDeclaration" && statement.importKind !== "type") {
      for (const specifier of statement.specifiers ?? []) {
        if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") continue;
        module.imports.set(specifier.local.name, {
          source: String(statement.source.value),
          imported: propertyName(specifier.imported) ?? specifier.local.name,
        });
      }
    }
    if (statement.type === "ExportNamedDeclaration" && !statement.declaration) {
      for (const specifier of statement.specifiers ?? []) {
        const exported = propertyName(specifier.exported);
        const local = propertyName(specifier.local);
        if (!exported || !local) continue;
        module.exports.set(
          exported,
          statement.source
            ? { source: String(statement.source.value), imported: local }
            : { local },
        );
      }
    }
    if (statement.type === "ExportAllDeclaration" && !statement.exported && statement.source)
      module.starExports.push(String(statement.source.value));
  }
  return module;
}

interface Scope {
  module: ParsedModule;
  modules: ModuleReader;
  locals: Map<string, Value>;
  depth: number;
}

function unwrap(node: AnyNode): AnyNode {
  while (node && typeWrappers.has(node.type)) node = node.expression;
  return node;
}

function evaluate(input: AnyNode, scope: Scope): Value {
  const node = unwrap(input);
  if (!node || scope.depth > 24) return UNKNOWN;
  switch (node.type) {
    case "Literal":
      if (node.regex) {
        try {
          return new RegExp(node.regex.pattern, node.regex.flags);
        } catch {
          return UNKNOWN;
        }
      }
      return node.value as Value;
    case "TemplateLiteral": {
      let out = "";
      for (let index = 0; index < node.quasis.length; index++) {
        const cooked = node.quasis[index].value.cooked;
        if (cooked === null || cooked === undefined) return UNKNOWN;
        out += cooked;
        if (index < node.expressions.length) {
          const value = evaluate(node.expressions[index], scope);
          if (!isPrimitive(value)) return UNKNOWN;
          out += String(value);
        }
      }
      return out;
    }
    case "Identifier":
      return identifierValue(node.name, scope);
    case "ArrayExpression": {
      const values: Value[] = [];
      for (const element of node.elements) {
        if (!element || element.type === "SpreadElement") return UNKNOWN;
        const value = evaluate(element, scope);
        if (value === UNKNOWN) return UNKNOWN;
        values.push(value);
      }
      return values;
    }
    case "UnaryExpression": {
      if (node.operator === "void") return undefined;
      const value = evaluate(node.argument, scope);
      if (value === UNKNOWN) return UNKNOWN;
      return node.operator === "!" ? !value : UNKNOWN;
    }
    case "BinaryExpression": {
      const left = evaluate(node.left, scope);
      const right = evaluate(node.right, scope);
      if (left === UNKNOWN || right === UNKNOWN) return UNKNOWN;
      if (node.operator === "+" && isPrimitive(left) && isPrimitive(right))
        return typeof left === "number" && typeof right === "number"
          ? left + right
          : String(left) + String(right);
      if (!isPrimitive(left) || !isPrimitive(right)) return UNKNOWN;
      if (node.operator === "===" || node.operator === "==") return left === right;
      if (node.operator === "!==" || node.operator === "!=") return left !== right;
      return UNKNOWN;
    }
    case "LogicalExpression": {
      const left = evaluate(node.left, scope);
      if (left === UNKNOWN) return UNKNOWN;
      if (node.operator === "&&") return left ? evaluate(node.right, scope) : left;
      if (node.operator === "||") return left ? left : evaluate(node.right, scope);
      return left ?? evaluate(node.right, scope);
    }
    case "ConditionalExpression": {
      const test = evaluate(node.test, scope);
      if (test === UNKNOWN) return UNKNOWN;
      return evaluate(test ? node.consequent : node.alternate, scope);
    }
    case "CallExpression":
      return evaluateCall(node, scope);
    default:
      return UNKNOWN;
  }
}

function evaluateCall(node: AnyNode, scope: Scope): Value {
  const callee = unwrap(node.callee);
  if (callee?.type !== "MemberExpression" || node.optional) return UNKNOWN;
  const method = callee.computed ? null : propertyName(callee.property);
  const target = evaluate(callee.object, scope);
  const args = node.arguments.map((argument: AnyNode) => evaluate(argument, scope));
  if (target === UNKNOWN || args.some((value: Value) => value === UNKNOWN)) return UNKNOWN;
  if (target instanceof RegExp && method === "test" && typeof args[0] === "string") {
    target.lastIndex = 0;
    return target.test(args[0]);
  }
  if (Array.isArray(target) && method === "includes") return target.includes(args[0]);
  if (typeof target !== "string") return UNKNOWN;
  const [first, second] = args;
  switch (method) {
    case "startsWith":
      return typeof first === "string" ? target.startsWith(first) : UNKNOWN;
    case "endsWith":
      return typeof first === "string" ? target.endsWith(first) : UNKNOWN;
    case "includes":
      return typeof first === "string" ? target.includes(first) : UNKNOWN;
    case "slice":
      return typeof first === "number" && (second === undefined || typeof second === "number")
        ? target.slice(first, second)
        : UNKNOWN;
    default:
      return UNKNOWN;
  }
}

function identifierValue(name: string, scope: Scope): Value {
  if (scope.locals.has(name)) return scope.locals.get(name)!;
  if (name === "undefined") return undefined;
  const declarator = scope.module.consts.get(name);
  if (declarator)
    return evaluate(declarator.init, { ...scope, locals: new Map(), depth: scope.depth + 1 });
  const imported = scope.module.imports.get(name);
  if (imported) return importedValue(scope, scope.module, imported.source, imported.imported);
  return UNKNOWN;
}

function importedValue(scope: Scope, from: ParsedModule, source: string, name: string): Value {
  if (scope.depth > 24) return UNKNOWN;
  const file = scope.modules.resolveImport(from.path, source);
  const module = file ? scope.modules.read(file) : null;
  if (!module) return UNKNOWN;
  const next: Scope = { ...scope, module, locals: new Map(), depth: scope.depth + 1 };
  const exported = module.exports.get(name);
  if (exported?.source) return importedValue(next, module, exported.source, exported.imported!);
  if (exported?.local) return identifierValue(exported.local, next);
  for (const star of module.starExports) {
    const value = importedValue(next, module, star, name);
    if (value !== UNKNOWN) return value;
  }
  return UNKNOWN;
}

function isPrimitive(value: Value): value is string | number | boolean | null | undefined {
  return value !== UNKNOWN && !(value instanceof RegExp) && !Array.isArray(value);
}

interface ResolveIdHook {
  module: ParsedModule;
  fn: AnyNode;
  param: string | null;
  filter: AnyNode;
}

function findResolveIdHooks(module: ParsedModule): ResolveIdHook[] {
  const hooks: ResolveIdHook[] = [];
  walk(module.program, (node) => {
    if (node.type !== "ObjectExpression") return;
    const properties = new Map<string, AnyNode>();
    for (const property of node.properties) {
      if (property.type !== "Property" || property.computed) continue;
      const key = propertyName(property.key);
      if (key) properties.set(key, property);
    }
    const hook = properties.get("resolveId");
    if (!hook || (!properties.has("name") && !properties.has("load"))) return;
    const apply = unwrap(properties.get("apply")?.value);
    if (apply?.type === "Literal" && apply.value === "build") return;
    // A plugin limited by applyToEnvironment may never run for the browser environment.
    if (properties.has("applyToEnvironment")) return;
    let fn = unwrap(hook.value);
    let filter: AnyNode = null;
    if (fn?.type === "ObjectExpression") {
      for (const property of fn.properties) {
        const key =
          property.type === "Property" && !property.computed ? propertyName(property.key) : null;
        if (key === "handler") fn = unwrap(property.value);
        if (key === "filter") filter = unwrap(property.value);
      }
    }
    if (!fn || !/Function/.test(fn.type)) return;
    const first = fn.params[0];
    hooks.push({
      module,
      fn,
      param: first?.type === "Identifier" ? first.name : null,
      filter,
    });
  });
  return hooks;
}

interface ResolvedValue {
  value: Value;
  node: AnyNode;
}

/** The ids a resolveId hook can return for one import specifier, when a filter or a branch on the specifier selects them. */
function resolveSpecifier(
  hook: ResolveIdHook,
  specifier: string,
  modules: ModuleReader,
): ResolvedValue[] {
  if (!hook.param) return [];
  const scope: Scope = {
    module: hook.module,
    modules,
    locals: new Map([[hook.param, specifier]]),
    depth: 0,
  };
  let linked = false;
  const filter = filterProperty(hook.filter, "id");
  if (filter) {
    const passes = filterPasses(filter, specifier, scope);
    if (passes === false) return [];
    linked = passes === true;
  }
  const results: ResolvedValue[] = [];
  const onReturn = (argument: AnyNode, state: PathState, locals: Map<string, Value>) => {
    if (!argument || state.gated || !(linked || state.linked)) return;
    for (const resolved of possibleValues(argument, { ...scope, locals })) results.push(resolved);
  };
  if (hook.fn.body.type !== "BlockStatement")
    onReturn(hook.fn.body, { gated: false, linked: false }, scope.locals);
  else
    execute(
      hook.fn.body.body,
      new Map(scope.locals),
      { gated: false, linked: false },
      {
        scope,
        param: hook.param,
        onReturn,
      },
    );
  return results;
}

function filterProperty(filter: AnyNode, key: string): AnyNode {
  if (filter?.type !== "ObjectExpression") return null;
  for (const property of filter.properties) {
    if (property.type === "Property" && !property.computed && propertyName(property.key) === key)
      return unwrap(property.value);
  }
  return null;
}

function filterPasses(filter: AnyNode, specifier: string, scope: Scope): boolean | null {
  const matches = (pattern: Value): boolean | null => {
    if (pattern instanceof RegExp) {
      pattern.lastIndex = 0;
      return pattern.test(specifier);
    }
    if (typeof pattern === "string") return pattern === specifier;
    if (Array.isArray(pattern)) {
      const results = pattern.map(matches);
      if (results.includes(true)) return true;
      return results.includes(null) ? null : false;
    }
    return null;
  };
  if (filter.type === "ObjectExpression") {
    const include = filterProperty(filter, "include");
    const exclude = filterProperty(filter, "exclude");
    if (exclude && matches(evaluate(exclude, scope)) === true) return false;
    return include ? matches(evaluate(include, scope)) : null;
  }
  return matches(evaluate(filter, scope));
}

interface PathState {
  /** A condition about SSR or the Vite environment chose this branch. */
  gated: boolean;
  /** A filter or a condition on the specifier chose this branch. */
  linked: boolean;
}

interface Execution {
  scope: Scope;
  param: string;
  onReturn(argument: AnyNode, state: PathState, locals: Map<string, Value>): void;
}

/** Walks statements for one specifier and reports every return it can reach. Returns whether control can fall through. */
function execute(
  statements: AnyNode[],
  locals: Map<string, Value>,
  state: PathState,
  run: Execution,
): boolean {
  for (const statement of statements) {
    if (!executeStatement(statement, locals, state, run)) return false;
  }
  return true;
}

function executeStatement(
  statement: AnyNode,
  locals: Map<string, Value>,
  state: PathState,
  run: Execution,
): boolean {
  const scope = { ...run.scope, locals };
  switch (statement?.type) {
    case "ReturnStatement":
      run.onReturn(statement.argument, state, locals);
      return false;
    case "BlockStatement":
      return execute(statement.body, locals, state, run);
    case "VariableDeclaration":
      for (const item of statement.declarations) {
        if (item.id.type !== "Identifier") continue;
        locals.set(
          item.id.name,
          statement.kind === "const" && item.init ? evaluate(item.init, scope) : UNKNOWN,
        );
      }
      return true;
    case "IfStatement": {
      const test = evaluate(statement.test, scope);
      const onSpecifier = mentions(statement.test, run.param);
      if (test !== UNKNOWN) {
        // A guard such as `if (id !== VIRTUAL_ID) return` lets only that specifier reach what follows.
        if (onSpecifier && (test || isNegation(statement.test))) state.linked = true;
        const branch = test ? statement.consequent : statement.alternate;
        return branch ? executeStatement(branch, new Map(locals), { ...state }, run) : true;
      }
      const consequentState = conjunctState(statement.test, scope, run, state);
      const elseState = {
        gated: state.gated || environmentGateRe.test(sourceOf(run.scope.module, statement.test)),
        linked: state.linked,
      };
      const consequent = consequentState
        ? executeStatement(statement.consequent, new Map(locals), consequentState, run)
        : true;
      // The else branch of a test on the specifier is reached by every other specifier.
      const alternate =
        statement.alternate && !onSpecifier
          ? executeStatement(statement.alternate, new Map(locals), elseState, run)
          : true;
      return consequent || alternate;
    }
    case "SwitchStatement": {
      const discriminant = evaluate(statement.discriminant, scope);
      const onSpecifier = mentions(statement.discriminant, run.param);
      let matched = false;
      for (const item of statement.cases) {
        if (!matched) {
          const value = item.test ? evaluate(item.test, scope) : discriminant;
          if (discriminant === UNKNOWN || value === UNKNOWN) {
            if (onSpecifier) continue;
          } else if (item.test && value !== discriminant) continue;
          matched = discriminant !== UNKNOWN && value !== UNKNOWN;
          if (matched && onSpecifier) state.linked = true;
          const falls = execute(item.consequent, new Map(locals), { ...state }, run);
          if (matched && !falls) return false;
          continue;
        }
        if (!execute(item.consequent, new Map(locals), state, run)) return false;
      }
      return true;
    }
    case "TryStatement":
      execute(statement.block.body, new Map(locals), state, run);
      if (statement.handler) execute(statement.handler.body.body, new Map(locals), state, run);
      return statement.finalizer
        ? execute(statement.finalizer.body, new Map(locals), state, run)
        : true;
    case "ForStatement":
    case "ForOfStatement":
    case "ForInStatement":
    case "WhileStatement":
    case "DoWhileStatement":
    case "LabeledStatement":
      executeStatement(statement.body, new Map(locals), state, run);
      return true;
    default:
      return true;
  }
}

function isNegation(input: AnyNode): boolean {
  const node = unwrap(input);
  return (
    (node?.type === "UnaryExpression" && node.operator === "!") ||
    (node?.type === "BinaryExpression" && (node.operator === "!==" || node.operator === "!="))
  );
}

/**
 * The state inside `if (a && b && ...)` for one specifier, or `null` when a known conjunct is
 * false or an unknown one depends on the specifier. Unknown conjuncts about SSR or the Vite
 * environment gate the branch away from the browser.
 */
function conjunctState(
  test: AnyNode,
  scope: Scope,
  run: Execution,
  state: PathState,
): PathState | null {
  const conjuncts: AnyNode[] = [];
  const split = (input: AnyNode) => {
    const node = unwrap(input);
    if (node?.type === "LogicalExpression" && node.operator === "&&") {
      split(node.left);
      split(node.right);
    } else conjuncts.push(node);
  };
  split(test);
  const next = { ...state };
  for (const conjunct of conjuncts) {
    const value = evaluate(conjunct, scope);
    const onSpecifier = mentions(conjunct, run.param);
    if (value !== UNKNOWN) {
      if (!value) return null;
      if (onSpecifier) next.linked = true;
      continue;
    }
    if (onSpecifier) return null;
    if (environmentGateRe.test(sourceOf(run.scope.module, conjunct))) next.gated = true;
  }
  return next;
}

function possibleValues(input: AnyNode, scope: Scope): ResolvedValue[] {
  const node = unwrap(input);
  if (!node) return [];
  if (node.type === "LogicalExpression" || node.type === "ConditionalExpression") {
    const value = evaluate(node, scope);
    if (value !== UNKNOWN) return [{ value, node }];
    if (node.type === "ConditionalExpression")
      return [...possibleValues(node.consequent, scope), ...possibleValues(node.alternate, scope)];
    return node.operator === "&&"
      ? possibleValues(node.right, scope)
      : [...possibleValues(node.left, scope), ...possibleValues(node.right, scope)];
  }
  if (node.type === "ObjectExpression") {
    const id = filterProperty(node, "id");
    return id ? possibleValues(id, scope) : [];
  }
  if (node.type === "AwaitExpression") return possibleValues(node.argument, scope);
  const value = evaluate(node, scope);
  return value === UNKNOWN ? [] : [{ value, node }];
}

/** A returned module-level const is fixed where it is declared. */
function reportSite(module: ParsedModule, input: AnyNode): { start: number; end: number } {
  const node = unwrap(input);
  const declarator = node?.type === "Identifier" ? module.consts.get(node.name) : undefined;
  const target = declarator ?? node;
  return { start: target.start, end: target.end };
}

function mentions(node: AnyNode, name: string): boolean {
  let found = false;
  walk(node, (child) => {
    if (child.type === "Identifier" && child.name === name) found = true;
  });
  return found;
}

function sourceOf(module: ParsedModule, node: AnyNode): string {
  return module.text.slice(node.start, node.end);
}

function walk(node: AnyNode, visit: (node: AnyNode) => void) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node.type === "string") visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "__doctorParent" || key === "parent") continue;
    if (value && typeof value === "object") walk(value, visit);
  }
}

interface ImportSite {
  specifier: string;
  start: number;
  end: number;
  local: boolean;
}

async function findBrowserImports(
  ctx: RuleContext,
  files: Array<{ path: string }>,
  modules: ModuleReader,
): Promise<BrowserImport[]> {
  const found: BrowserImport[] = [];
  const htmlReachable = await htmlEntryModules(ctx, modules, found);
  for (const entry of files) {
    const text = ctx.fs.readText(entry.path);
    if (!text || !hashImportRe.test(text)) continue;
    const program = entry.path.endsWith(".vue")
      ? parseVueScripts(entry.path, (await parseSfcFile(entry.path, text)).descriptor, text)
      : modules.read(entry.path)?.program;
    if (!program) continue;
    const sites = importSites(program);
    const evidence = htmlReachable.get(entry.path) ?? directBrowserEvidence(entry.path, sites);
    if (!evidence) continue;
    for (const site of sites) {
      if (!site.specifier.includes("#")) continue;
      found.push({
        file: entry.path,
        specifier: site.specifier,
        range: ctx.helpers.rangeFromOffsets(entry.path, text, site.start, site.end),
        evidence,
      });
    }
  }
  return found;
}

function directBrowserEvidence(path: string, sites: ImportSite[]): string | null {
  if (/(?:^|\/)server\/|\.server\.[^/]+$/.test(path)) return null;
  if (path.endsWith(".vue")) return "a Vue single-file component";
  if (/\.client\.[^/]+$/.test(path)) return "a .client module";
  if (sites.some((site) => site.specifier === "vue/server-renderer")) return null;
  if (sites.some((site) => site.specifier === "vue"))
    return "a module that imports Vue runtime APIs";
  return null;
}

function importSites(program: AnyNode): ImportSite[] {
  const sites: ImportSite[] = [];
  const add = (source: AnyNode) => {
    if (typeof source?.value !== "string") return;
    sites.push({
      specifier: source.value,
      start: source.start,
      end: source.end,
      local: source.value.startsWith("."),
    });
  };
  for (const statement of program.body ?? []) {
    if (statement.type === "ImportDeclaration") {
      const typeOnly =
        statement.importKind === "type" ||
        (statement.specifiers?.length > 0 &&
          statement.specifiers.every((item: AnyNode) => item.importKind === "type"));
      if (!typeOnly) add(statement.source);
    }
    if (
      (statement.type === "ExportNamedDeclaration" || statement.type === "ExportAllDeclaration") &&
      statement.source &&
      statement.exportKind !== "type"
    )
      add(statement.source);
  }
  walk(program, (node) => {
    if (node.type === "ImportExpression") add(unwrap(node.source));
  });
  return sites;
}

/** Modules that an HTML page loads with `<script type="module">`, directly or through relative imports. */
async function htmlEntryModules(
  ctx: RuleContext,
  modules: ModuleReader,
  found: BrowserImport[],
): Promise<Map<string, string>> {
  const reachable = new Map<string, string>();
  const queue: string[] = [];
  const pages = ctx.fs.glob("**/*.html", { exclude: [...SOURCE_EXCLUDE, "**/public/**"] });
  for (const page of pages) {
    const html = ctx.fs.readText(page);
    if (!html?.includes("module")) continue;
    const pageName = relative(ctx.project.root, page);
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const attributes = match[1]!;
      if (!/\btype\s*=\s*["']?module\b/i.test(attributes)) continue;
      const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1];
      if (src) {
        if (/^[a-z]+:|^\/\//i.test(src)) continue;
        const base = src.startsWith("/")
          ? resolve(dirname(page), `.${src}`)
          : resolve(dirname(page), src);
        const file = modules.resolveImport(page, `./${relative(dirname(page), base)}`);
        if (file && !reachable.has(file)) {
          reachable.set(file, `loaded by ${pageName}`);
          queue.push(file);
        }
        continue;
      }
      const body = match[2]!;
      const offset = match.index! + match[0].indexOf(">") + 1;
      const program = parseScript(`${page}.inline.ts`, body, "ts");
      if (!program) continue;
      for (const site of importSites(program)) {
        if (!site.specifier.includes("#")) continue;
        found.push({
          file: page,
          specifier: site.specifier,
          range: ctx.helpers.rangeFromOffsets(page, html, offset + site.start, offset + site.end),
          evidence: `an inline module script in ${pageName}`,
        });
      }
    }
  }
  for (let index = 0; index < queue.length && index < 5000; index++) {
    const file = queue[index]!;
    const program = modules.read(file)?.program;
    if (!program) continue;
    for (const site of importSites(program)) {
      if (!site.local) continue;
      const target = modules.resolveImport(file, site.specifier);
      if (!target || reachable.has(target)) continue;
      reachable.set(target, reachable.get(file)!);
      queue.push(target);
    }
  }
  return reachable;
}
