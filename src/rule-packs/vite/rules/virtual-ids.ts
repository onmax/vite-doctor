import { matchesGlob } from "node:path";
import type { SFCDescriptor } from "@vue/compiler-sfc";
import { dirname, isAbsolute, relative, resolve } from "pathe";
import { createRule, type RuleContext, type SourceRange } from "../../../core/index.js";
import { parseScript } from "../../../core/internal/script.js";
import { parseSfcFile, parseVueScripts } from "../../../core/internal/sfc.js";
import { diagnostics } from "../../../diagnostics.js";
import { propertyName, type AnyNode } from "./shared.js";

const RULE_ID = "vite/plugin/no-fragment-in-virtual-id";
const UNKNOWN = Symbol("unknown");
const CLIENT_OPTIONS = Symbol("client options");
const CLIENT_ENVIRONMENT = Symbol("client environment");
const CLIENT_ENV_CONFIG = Symbol("client environment config");
type Value =
  | string
  | number
  | boolean
  | null
  | undefined
  | RegExp
  | Value[]
  | typeof UNKNOWN
  | typeof CLIENT_OPTIONS
  | typeof CLIENT_ENVIRONMENT
  | typeof CLIENT_ENV_CONFIG;

const scriptExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
// An import whose specifier holds "#": the only imports whose resolved id can carry one by convention.
const hashImportRe = /(?:\bfrom|\bimport)\s*\(?\s*["'`][^"'`\n]*#[^"'`\n]*["'`]/;
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
        const files = new Set(await ctx.inventory.sourcePaths());
        const modules = new ModuleReader(ctx, files);
        const apps = viteApps(modules, files);
        if (!apps.some((app) => app.hooks?.length)) return;
        const importers = await findBrowserImports(ctx, files, modules, apps);
        if (!importers.length) return;

        const findings = new Map<string, Finding>();
        for (const imported of importers) {
          if (/^(?:[a-z]+:)?\/\/|^data:/.test(imported.specifier)) continue;
          const app = imported.app;
          for (const hook of app?.hooks ?? []) {
            if (!hook.beforeBuiltin && couldResolveBuiltin(imported, modules)) break;
            const resolved = resolveSpecifier(hook, imported, modules);
            if (resolved === UNKNOWN) break;
            if (!resolved) continue;
            if (!resolved.wrapped || !resolved.value.includes("#")) break;
            const site = resolved.node;
            const { module } = hook.scope;
            const key = `${module.path}\0${site.start}\0${resolved.value}`;
            const finding = findings.get(key) ?? {
              file: module.path,
              range: ctx.helpers.rangeFromOffsets(module.path, module.text, site.start, site.end),
              id: resolved.value,
              specifier: imported.specifier,
              importers: [],
            };
            if (!finding.importers.some((item) => item.file === imported.file))
              finding.importers.push(imported);
            findings.set(key, finding);
            break;
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
  importerId: string | typeof UNKNOWN;
  specifier: string;
  range: SourceRange;
  evidence: string;
  app: ViteApp;
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
  functions: Map<string, AnyNode>;
  imports: Map<string, { source: string; imported: string }>;
  exports: Map<string, { local?: string; source?: string; imported?: string }>;
  starExports: string[];
}

class ModuleReader {
  private readonly modules = new Map<string, ParsedModule | null>();
  readonly ctx: RuleContext;
  private readonly files: ReadonlySet<string>;
  constructor(ctx: RuleContext, files: ReadonlySet<string>) {
    this.ctx = ctx;
    this.files = files;
  }

  read(path: string): ParsedModule | null {
    if (!this.files.has(path)) return null;
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
    const file = candidates.find((file) => this.ctx.fs.stat(file)?.isFile());
    return file && this.files.has(file) ? file : undefined;
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
    functions: new Map(),
    imports: new Map(),
    exports: new Map(),
    starExports: [],
  };
  for (const statement of program.body ?? []) {
    const declaration =
      statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
        ? statement.declaration
        : statement;
    if (statement.type === "ExportDefaultDeclaration")
      module.exports.set("default", { local: "*default*" });
    if (declaration?.type === "FunctionDeclaration" && declaration.id) {
      module.functions.set(declaration.id.name, declaration);
      if (statement.type === "ExportNamedDeclaration")
        module.exports.set(declaration.id.name, { local: declaration.id.name });
    }
    if (declaration?.type === "VariableDeclaration" && declaration.kind === "const") {
      for (const item of declaration.declarations) {
        if (item.id.type !== "Identifier" || !item.init) continue;
        module.consts.set(item.id.name, item);
        if (declaration !== statement) module.exports.set(item.id.name, { local: item.id.name });
      }
    }
    if (statement.type === "ImportDeclaration" && statement.importKind !== "type") {
      for (const specifier of statement.specifiers ?? []) {
        if (
          specifier.importKind === "type" ||
          !["ImportSpecifier", "ImportDefaultSpecifier"].includes(specifier.type)
        )
          continue;
        module.imports.set(specifier.local.name, {
          source: String(statement.source.value),
          imported:
            specifier.type === "ImportDefaultSpecifier"
              ? "default"
              : (propertyName(specifier.imported) ?? specifier.local.name),
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
  clientThis?: boolean;
}

function clientMember(target: Value, key: string | null): Value {
  if (target === CLIENT_OPTIONS && (key === "ssr" || key === "isEntry")) return false;
  if (target === CLIENT_ENVIRONMENT && key === "name") return "client";
  if (target === CLIENT_ENVIRONMENT && key === "config") return CLIENT_ENV_CONFIG;
  if (target === CLIENT_ENV_CONFIG && key === "consumer") return "client";
  return UNKNOWN;
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
    case "ChainExpression":
      return evaluate(node.expression, scope);
    case "MemberExpression": {
      const key = node.computed ? evaluate(node.property, scope) : propertyName(node.property);
      if (typeof key !== "string") return UNKNOWN;
      if (scope.clientThis && node.object.type === "ThisExpression" && key === "environment")
        return CLIENT_ENVIRONMENT;
      return clientMember(evaluate(node.object, scope), key);
    }
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
  return typeof value !== "symbol" && !(value instanceof RegExp) && !Array.isArray(value);
}

interface ResolveIdHook {
  scope: Scope;
  fn: AnyNode;
  filter: AnyNode;
  priority: number;
  enforce: number;
  beforeBuiltin: boolean;
}

interface ViteApp {
  directory: string;
  root: string;
  hooks?: ResolveIdHook[];
}

function within(root: string, file: string) {
  const path = relative(root, file);
  return path !== ".." && !path.startsWith("../") && !isAbsolute(path);
}

function viteApps(modules: ModuleReader, files: ReadonlySet<string>): ViteApp[] {
  const pattern = /^vite\.config\.[cm]?[jt]s$/;
  const directories = new Set(
    [...files].filter((file) => pattern.test(file.split("/").at(-1)!)).map(dirname),
  );
  const checked = new Set<string>();
  for (const file of files) {
    for (
      let directory = dirname(file);
      within(modules.ctx.project.root, directory);
      directory = dirname(directory)
    ) {
      if (directories.has(directory) || checked.has(directory)) break;
      checked.add(directory);
      if (
        scriptExtensions.some((extension) =>
          modules.ctx.fs.stat(resolve(directory, `vite.config${extension}`))?.isFile(),
        )
      ) {
        directories.add(directory);
        break;
      }
      if (directory === modules.ctx.project.root) break;
    }
  }
  return [...directories].map((directory) => {
    const app: ViteApp = { directory, root: directory };
    const candidates = scriptExtensions
      .filter((extension) => pattern.test(`vite.config${extension}`))
      .map((extension) => resolve(directory, `vite.config${extension}`))
      .filter((file) => modules.ctx.fs.stat(file)?.isFile());
    const module = candidates.length === 1 ? modules.read(candidates[0]!) : null;
    if (!module) return app;
    const scope: Scope = { module, modules, locals: new Map(), depth: 0 };
    let config = unwrap(
      module.program.body.find((node: AnyNode) => node.type === "ExportDefaultDeclaration")
        ?.declaration,
    );
    if (config?.type === "CallExpression" && config.callee.type === "Identifier") {
      const binding = module.imports.get(config.callee.name);
      if (binding?.source !== "vite" || binding.imported !== "defineConfig") return app;
      config = unwrap(config.arguments[0]);
    }
    if (config?.type === "Identifier") config = unwrap(module.consts.get(config.name)?.init);
    if (
      !staticObject(config) ||
      ["resolve", "environments", "experimental"].some((key) => filterProperty(config, key))
    )
      return app;
    const root = filterProperty(config, "root");
    if (root) {
      const value = evaluate(root, scope);
      if (typeof value !== "string") return app;
      app.root = resolve(directory, value);
    }
    const hooks: ResolveIdHook[] = [];
    const plugins = filterProperty(config, "plugins");
    if (plugins && !collectPlugins(plugins, scope, hooks)) return app;
    app.hooks = hooks.sort(
      (left, right) => left.priority - right.priority || left.enforce - right.enforce,
    );
    return app;
  });
}

function owningApp(apps: ViteApp[], file: string): ViteApp | undefined {
  return apps
    .filter((app) => within(app.directory, file) || within(app.root, file))
    .sort((left, right) => ownershipDepth(right, file) - ownershipDepth(left, file))[0];
}

function ownershipDepth(app: ViteApp, file: string) {
  return within(app.root, file)
    ? Math.max(app.root.length, app.directory.length)
    : app.directory.length;
}

function staticObject(node: AnyNode): boolean {
  return (
    node?.type === "ObjectExpression" &&
    node.properties.every(
      (property: AnyNode) =>
        property.type === "Property" && !property.computed && property.kind === "init",
    )
  );
}

function collectPlugins(input: AnyNode, scope: Scope, hooks: ResolveIdHook[]): boolean {
  const node = unwrap(input);
  if (!node || scope.depth > 24) return false;
  const next = { ...scope, depth: scope.depth + 1 };
  if (node.type === "ArrayExpression")
    return node.elements.every(
      (element: AnyNode) => !element || collectPlugins(element, next, hooks),
    );
  if (node.type === "CallExpression") {
    if (node.arguments.some((argument: AnyNode) => argument.type === "SpreadElement")) return false;
    const callee = unwrap(node.callee);
    if (callee?.type !== "Identifier") return false;
    const target = resolvePluginBinding(callee.name, scope);
    if (!target || !/Function/.test(target.node.type) || target.node.async || target.node.generator)
      return false;
    const locals = new Map<string, Value>();
    const fn = target.node;
    for (const [index, param] of fn.params.entries()) {
      if (param.type !== "Identifier") return false;
      const value = node.arguments[index] ? evaluate(node.arguments[index], scope) : undefined;
      locals.set(param.name, value);
    }
    const body = fn.body;
    const returned =
      body.type === "BlockStatement"
        ? body.body.length === 1 && body.body[0].type === "ReturnStatement"
          ? body.body[0].argument
          : null
        : body;
    return collectPlugins(returned, { ...target.scope, depth: next.depth, locals }, hooks);
  }
  if (node.type === "Identifier") {
    const target = resolvePluginBinding(node.name, scope);
    return (
      target !== undefined &&
      collectPlugins(target.node, { ...target.scope, depth: next.depth }, hooks)
    );
  }
  if (node.type === "Literal" && !node.value) return true;
  if (!staticObject(node)) return false;
  const apply = filterProperty(node, "apply");
  if (apply && evaluate(apply, scope) === "build") return true;
  if (apply && evaluate(apply, scope) !== "serve") return false;
  if (filterProperty(node, "config") || filterProperty(node, "configResolved")) return false;
  let fn = filterProperty(node, "resolveId");
  if (!fn) return true;
  if (filterProperty(node, "applyToEnvironment")) return false;
  let filter: AnyNode = null;
  let priority = 0;
  if (staticObject(fn)) {
    const order = filterProperty(fn, "order");
    if (order) {
      const value = evaluate(order, scope);
      if (value !== "pre" && value !== "post") return false;
      priority = value === "pre" ? -1 : 1;
    }
    filter = filterProperty(fn, "filter");
    fn = filterProperty(fn, "handler");
  }
  if (!fn || !/Function/.test(fn.type) || fn.generator) return false;
  const enforceNode = filterProperty(node, "enforce");
  const enforceValue = enforceNode ? evaluate(enforceNode, scope) : undefined;
  if (enforceValue !== undefined && enforceValue !== "pre" && enforceValue !== "post") return false;
  const enforce = enforceValue === "pre" ? -1 : enforceValue === "post" ? 1 : 0;
  hooks.push({
    scope,
    fn,
    filter,
    priority,
    enforce,
    beforeBuiltin: priority < 0 || (priority === 0 && enforce < 0),
  });
  return true;
}

function resolvePluginBinding(
  name: string,
  scope: Scope,
): { node: AnyNode; scope: Scope } | undefined {
  if (scope.depth > 24 || scope.locals.has(name)) return undefined;
  const node =
    name === "*default*"
      ? scope.module.program.body.find(
          (statement: AnyNode) => statement.type === "ExportDefaultDeclaration",
        )?.declaration
      : (scope.module.consts.get(name)?.init ?? scope.module.functions.get(name));
  if (node) return { node: unwrap(node), scope: { ...scope, locals: new Map() } };
  const imported = scope.module.imports.get(name);
  if (!imported) return undefined;
  const file = scope.modules.resolveImport(scope.module.path, imported.source);
  const module = file ? scope.modules.read(file) : null;
  const exported = module?.exports.get(imported.imported);
  if (!module || !exported?.local) return undefined;
  return resolvePluginBinding(exported.local, {
    ...scope,
    module,
    locals: new Map(),
    depth: scope.depth + 1,
  });
}

function couldResolveBuiltin(imported: BrowserImport, modules: ModuleReader) {
  const specifier = imported.specifier;
  if (/^(?:\.|\/|[\w-]+:)/.test(specifier) && !specifier.startsWith("virtual:")) return true;
  if (!specifier.startsWith("#")) return false;
  const { fs, project } = modules.ctx;
  for (let dir = dirname(imported.file); within(project.root, dir); dir = dirname(dir)) {
    const path = resolve(dir, "package.json");
    if (fs.stat(path)?.isFile()) {
      const manifest = fs.readJson(path) as { imports?: unknown } | undefined;
      return !manifest || Boolean(manifest.imports);
    }
    if (dir === project.root) break;
  }
  return false;
}

interface ResolvedValue {
  value: string;
  node: AnyNode;
  wrapped: boolean;
}

function resolveSpecifier(
  hook: ResolveIdHook,
  imported: BrowserImport,
  modules: ModuleReader,
): ResolvedValue | null | typeof UNKNOWN {
  if (hook.filter) {
    if (!staticObject(hook.filter)) return UNKNOWN;
    const filter = filterProperty(hook.filter, "id");
    if (filter) {
      const passes = filterPasses(filter, imported.specifier, hook.scope);
      if (passes === UNKNOWN) return UNKNOWN;
      if (!passes) return null;
    }
  }
  const scope: Scope = {
    ...hook.scope,
    modules,
    locals: new Map(hook.scope.locals),
    clientThis: hook.fn.type !== "ArrowFunctionExpression",
  };
  const args: Value[] = [imported.specifier, imported.importerId, CLIENT_OPTIONS];
  for (const [index, param] of hook.fn.params.entries()) {
    if (param.type === "Identifier") scope.locals.set(param.name, args[index]);
    else if (param.type === "ObjectPattern" && index === 2) {
      bindUnknown(param, scope.locals);
      for (const prop of param.properties) {
        if (prop.type !== "Property" || prop.computed || prop.value.type !== "Identifier") continue;
        scope.locals.set(prop.value.name, clientMember(CLIENT_OPTIONS, propertyName(prop.key)));
      }
    } else bindUnknown(param, scope.locals);
  }
  const body = hook.fn.body;
  let hasVar = false;
  walk(body, (node) => {
    if (node.type === "VariableDeclaration" && node.kind === "var") hasVar = true;
  });
  if (hasVar) return UNKNOWN;
  const result =
    body.type === "BlockStatement" ? execute(body.body, scope) : resolvedValue(body, scope);
  return result === FALLS ? null : result === BREAKS ? UNKNOWN : result;
}

function filterProperty(filter: AnyNode, key: string): AnyNode {
  if (filter?.type !== "ObjectExpression") return null;
  for (const property of [...filter.properties].reverse()) {
    if (property.type === "Property" && !property.computed && propertyName(property.key) === key)
      return unwrap(property.value);
  }
  return null;
}

function filterPasses(filter: AnyNode, specifier: string, scope: Scope): boolean | typeof UNKNOWN {
  const id = specifier.replaceAll("\\", "/");
  const matches = (pattern: Value): boolean | typeof UNKNOWN => {
    if (pattern instanceof RegExp) {
      pattern.lastIndex = 0;
      return pattern.test(id);
    }
    if (typeof pattern === "string") {
      if (!pattern.startsWith("**") && !isAbsolute(pattern) && !isAbsolute(id)) return false;
      // Match the common subset where Node's glob matcher and Vite's dot-enabled picomatch agree.
      if (!/^[\w/#.:*-]+$/.test(pattern) || id.split("/").some((part) => part.startsWith(".")))
        return UNKNOWN;
      if (!pattern.startsWith("**") && !isAbsolute(pattern)) return UNKNOWN;
      return matchesGlob(id, pattern);
    }
    return UNKNOWN;
  };
  const list = (node: AnyNode, empty: boolean): boolean | typeof UNKNOWN => {
    if (!node) return empty;
    const value = evaluate(node, scope);
    if (!Array.isArray(value)) return matches(value);
    if (!value.length) return empty;
    const results = value.map(matches);
    return results.includes(true) ? true : results.includes(UNKNOWN) ? UNKNOWN : false;
  };
  if (filter.type === "ObjectExpression") {
    if (!staticObject(filter)) return UNKNOWN;
    const excluded = list(filterProperty(filter, "exclude"), false);
    const included = list(filterProperty(filter, "include"), true);
    if (excluded === true || included === false) return false;
    return excluded === UNKNOWN ? UNKNOWN : included;
  }
  return list(filter, true);
}

const FALLS = Symbol("fallthrough");
const BREAKS = Symbol("break");
type ExecutionResult = ResolvedValue | null | typeof UNKNOWN | typeof FALLS | typeof BREAKS;

function bindUnknown(pattern: AnyNode, locals: Map<string, Value>): void {
  switch (pattern?.type) {
    case "Identifier":
      locals.set(pattern.name, UNKNOWN);
      break;
    case "ObjectPattern":
      for (const prop of pattern.properties)
        bindUnknown(prop.type === "RestElement" ? prop.argument : prop.value, locals);
      break;
    case "ArrayPattern":
      for (const item of pattern.elements) bindUnknown(item, locals);
      break;
    case "AssignmentPattern":
      bindUnknown(pattern.left, locals);
      break;
    case "RestElement":
      bindUnknown(pattern.argument, locals);
      break;
  }
}

function execute(statements: AnyNode[], parent: Scope, declarations = statements): ExecutionResult {
  const locals = new Map(parent.locals);
  const scope = { ...parent, locals };
  for (const statement of declarations) {
    if (statement.type === "VariableDeclaration")
      for (const item of statement.declarations) bindUnknown(item.id, locals);
    if (["FunctionDeclaration", "ClassDeclaration"].includes(statement.type))
      bindUnknown(statement.id, locals);
  }
  for (const statement of statements) {
    const result = executeStatement(statement, scope);
    if (result !== FALLS) return result;
  }
  return FALLS;
}

function executeStatement(statement: AnyNode, scope: Scope): ExecutionResult {
  switch (statement?.type) {
    case "BlockStatement":
      return execute(statement.body, scope);
    case "ReturnStatement":
      return resolvedValue(statement.argument, scope);
    case "BreakStatement":
      return statement.label ? UNKNOWN : BREAKS;
    case "EmptyStatement":
    case "FunctionDeclaration":
    case undefined:
      return FALLS;
    case "VariableDeclaration":
      if (statement.kind === "var") return UNKNOWN;
      for (const item of statement.declarations) {
        if (item.id.type === "Identifier" && statement.kind === "const")
          scope.locals.set(item.id.name, evaluate(item.init, scope));
      }
      return FALLS;
    case "IfStatement": {
      const condition = evaluate(statement.test, scope);
      return condition === UNKNOWN
        ? UNKNOWN
        : executeStatement(condition ? statement.consequent : statement.alternate, scope);
    }
    case "SwitchStatement": {
      const discriminant = evaluate(statement.discriminant, scope);
      if (discriminant === UNKNOWN) return UNKNOWN;
      const declarations = statement.cases.flatMap((item: AnyNode) => item.consequent);
      const caseScope = { ...scope, locals: new Map(scope.locals) };
      for (const declaration of declarations) {
        if (declaration.type === "VariableDeclaration")
          for (const item of declaration.declarations) bindUnknown(item.id, caseScope.locals);
        if (["FunctionDeclaration", "ClassDeclaration"].includes(declaration.type))
          bindUnknown(declaration.id, caseScope.locals);
      }
      let start = -1;
      let fallback = -1;
      for (const [index, item] of statement.cases.entries()) {
        if (!item.test) {
          fallback = index;
          continue;
        }
        const value = evaluate(item.test, caseScope);
        if (value === UNKNOWN) return UNKNOWN;
        if (value === discriminant) {
          start = index;
          break;
        }
      }
      if (start < 0) start = fallback;
      if (start < 0) return FALLS;
      const result = execute(
        statement.cases.slice(start).flatMap((item: AnyNode) => item.consequent),
        caseScope,
        declarations,
      );
      return result === BREAKS ? FALLS : result;
    }
    default:
      return UNKNOWN;
  }
}

function resolvedValue(input: AnyNode, scope: Scope): ResolvedValue | null | typeof UNKNOWN {
  const node = unwrap(input);
  if (!node) return null;
  if (node.type === "AwaitExpression") return resolvedValue(node.argument, scope);
  if (node.type === "ConditionalExpression") {
    const test = evaluate(node.test, scope);
    return test === UNKNOWN
      ? UNKNOWN
      : resolvedValue(test ? node.consequent : node.alternate, scope);
  }
  if (node.type === "LogicalExpression") {
    const left = evaluate(node.left, scope);
    if (left === UNKNOWN) return UNKNOWN;
    const takesRight =
      node.operator === "&&" ? left : node.operator === "||" ? !left : left == null;
    return resolvedValue(takesRight ? node.right : node.left, scope);
  }
  if (node.type === "ObjectExpression") {
    const id = filterProperty(node, "id");
    return staticObject(node) && id ? (resolvedValue(id, scope) ?? UNKNOWN) : UNKNOWN;
  }
  const value = evaluate(node, scope);
  if (value === null || value === undefined || value === false) return null;
  if (typeof value !== "string") return UNKNOWN;
  const declarator =
    node.type === "Identifier" && !scope.locals.has(node.name)
      ? scope.module.consts.get(node.name)
      : undefined;
  return { value, node: declarator ?? node, wrapped: !/^(?:[./]|[a-z]+:\/\/|data:)/.test(value) };
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
}

async function findBrowserImports(
  ctx: RuleContext,
  files: ReadonlySet<string>,
  modules: ModuleReader,
  apps: ViteApp[],
): Promise<BrowserImport[]> {
  const found: BrowserImport[] = [];
  const htmlReachable = await htmlEntryModules(ctx, modules, apps, found);
  for (const file of files) {
    const app = owningApp(apps, file);
    if (!app?.hooks?.length && !htmlReachable.has(file)) continue;
    const text = ctx.fs.readText(file);
    if (!text || !hashImportRe.test(text)) continue;
    const program = file.endsWith(".vue")
      ? parseVueScripts(file, (await parseSfcFile(file, text)).descriptor, text)
      : modules.read(file)?.program;
    if (!program) continue;
    const sites = importSites(program);
    const contexts = htmlReachable.get(file) ?? new Map<ViteApp, string>();
    const evidence = directBrowserEvidence(file, sites);
    if (evidence && app && !contexts.has(app)) contexts.set(app, evidence);
    for (const site of sites) {
      if (!site.specifier.includes("#")) continue;
      for (const [app, evidence] of contexts) {
        found.push({
          file,
          importerId: file,
          specifier: site.specifier,
          range: ctx.helpers.rangeFromOffsets(file, text, site.start, site.end),
          evidence,
          app,
        });
      }
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
      statement.exportKind !== "type" &&
      !(
        statement.specifiers?.length > 0 &&
        statement.specifiers.every((item: AnyNode) => item.exportKind === "type")
      )
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
  apps: ViteApp[],
  found: BrowserImport[],
): Promise<Map<string, Map<ViteApp, string>>> {
  const reachable = new Map<string, Map<ViteApp, string>>();
  const queue: Array<{ file: string; app: ViteApp; evidence: string }> = [];
  const enqueue = (file: string | undefined, app: ViteApp, evidence: string) => {
    if (!file) return;
    const contexts = reachable.get(file) ?? new Map<ViteApp, string>();
    if (contexts.has(app)) return;
    contexts.set(app, evidence);
    reachable.set(file, contexts);
    queue.push({ file, app, evidence });
  };
  const dependency = (file: string, app: ViteApp, source: string) => {
    if (source.startsWith("//") || !/^(?:\.|\/)/.test(source)) return undefined;
    const [path, query] = source.split("#", 1)[0]!.split(/\?(.*)/s, 2);
    if (!path || (query && /(?:^|&)(?:raw|url)(?:&|$)/.test(query))) return undefined;
    const local = path.startsWith("/")
      ? `./${relative(dirname(file), resolve(app.root, `.${path}`))}`
      : path;
    return modules.resolveImport(file, local);
  };
  const pages = await ctx.inventory.sourcePaths("html");
  for (const page of pages) {
    const app = owningApp(apps, page);
    if (!app?.hooks?.length || !within(app.root, page)) continue;
    const html = ctx.fs.readText(page);
    if (!html || !/module/i.test(html)) continue;
    const pageName = relative(ctx.project.root, page);
    const prefix = "<template>";
    const parsed = await parseSfcFile(page, `${prefix}${html}</template>`);
    const descriptor = parsed.descriptor as SFCDescriptor;
    const visit = (
      node: NonNullable<NonNullable<typeof descriptor.template>["ast"]>["children"][number],
    ) => {
      if (node.type !== 1) return;
      const tag = node.tag.toLowerCase();
      if (
        [
          "template",
          "noscript",
          "textarea",
          "title",
          "style",
          "xmp",
          "iframe",
          "noembed",
          "noframes",
        ].includes(tag)
      )
        return;
      if (tag !== "script") {
        node.children.forEach(visit);
        return;
      }
      const attribute = (name: string) =>
        node.props.find((prop) => prop.type === 6 && prop.name.toLowerCase() === name);
      const type = attribute("type");
      if (type?.type !== 6 || type.value?.content !== "module") return;
      const src = attribute("src");
      const evidence = `loaded by ${pageName}`;
      if (src?.type === 6) {
        const value = src.value?.content;
        if (value && !/^[\w+.-]+:/.test(value))
          enqueue(dependency(page, app, /^[./]/.test(value) ? value : `./${value}`), app, evidence);
        return;
      }
      const inline = node.children[0];
      if (inline?.type !== 2) return;
      const offset = inline.loc.start.offset - prefix.length;
      const program = parseScript(`${page}.inline.js`, inline.loc.source, "js");
      if (!program) return;
      for (const site of importSites(program)) {
        enqueue(dependency(page, app, site.specifier), app, evidence);
        if (site.specifier.includes("#"))
          found.push({
            file: page,
            importerId: UNKNOWN,
            specifier: site.specifier,
            range: ctx.helpers.rangeFromOffsets(page, html, offset + site.start, offset + site.end),
            evidence: `an inline module script in ${pageName}`,
            app,
          });
      }
    };
    descriptor.template?.ast?.children.forEach(visit);
  }
  for (let index = 0; index < queue.length && index < 5000; index++) {
    const { file, app, evidence } = queue[index]!;
    const program = modules.read(file)?.program;
    if (!program) continue;
    for (const site of importSites(program)) {
      enqueue(dependency(file, app, site.specifier), app, evidence);
    }
  }
  return reachable;
}
