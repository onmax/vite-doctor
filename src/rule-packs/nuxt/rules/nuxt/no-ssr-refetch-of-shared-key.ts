import { dirname, relative, resolve } from "pathe";
import { createRule, type RuleContext, type SourceRange } from "../../../../core/index.js";
import { parseScript } from "../../../../core/internal/script.js";
import { parseSfcFile, parseVueScripts } from "../../../../core/internal/sfc.js";
// oxlint-disable-next-line no-restricted-imports -- walks the project tree, so the Rule declares cacheScope "none".
import { selectScanFiles } from "../../../../core/internal/source-inventory.js";
import { diagnostics } from "../../diagnostics.js";
import { exportedFunctions } from "./composable-analysis.js";
import { patternNames } from "./script-index.js";
import type { AnyNode } from "./shared.js";

const RULE_ID = "nuxt/fetch/no-ssr-refetch-of-shared-key";
const FETCH_CALLS = new Set(["useFetch", "useLazyFetch"]);
const ASYNC_DATA_CALLS = new Set(["useAsyncData", "useLazyAsyncData"]);
const FACTORY_CALLS = new Set(["createUseFetch", "createUseAsyncData"]);
const NUXT_SOURCE_RE = /^(?:#imports|#app(?:\/.*)?|nuxt\/app|nuxt)$/;
const SCRIPT_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);
// Options that feed useFetch's generated key when no explicit `key` is passed.
const FETCH_KEY_OPTIONS = ["method", "baseURL", "query", "params", "body"];
const CACHE_FIX =
  "(key, nuxtApp, ctx) => ctx.cause === 'initial' ? nuxtApp.payload.data[key] : undefined";
const ALL = "*";
const MAX_RELATED = 8;

type Role = "app" | "page" | "layout" | "component" | "middleware" | "plugin";

interface SourceFile {
  path: string;
  displayPath: string;
  text: string;
  program: AnyNode;
  vue: boolean;
  setup?: { start: number; end: number };
  clientOnlyRanges: Array<[number, number]>;
  conditionalRanges: Array<[number, number]>;
  imports: Map<string, { source: string; imported: string }>;
  /** Module-level names with their initializer, null for destructured names and classes. */
  moduleBindings: Map<string, { init: AnyNode; constant: boolean }>;
  shadowed: Set<string>;
}

interface AppFile {
  role: Role;
  /** Layout or named middleware name; global middleware has none. */
  name?: string;
  global?: boolean;
}

type Target = { nuxt: string } | { file: string; name: string } | { auto: string } | null;

interface Factory {
  kind: "fetch" | "asyncData";
  text: string;
  options: AnyNode;
  param?: string;
}

interface OptionVerdict {
  defer: boolean;
  cached: boolean;
  cacheReference?: string;
}

interface FetchCall {
  groupKey: string;
  keyLabel: string;
  file: SourceFile;
  node: AnyNode;
  callee: string;
  /** null: the call never fetches during SSR. "unknown": options Doctor cannot prove. */
  verdict: OptionVerdict | null | "unknown";
  factory?: Factory;
  composable?: string;
}

interface CallSite {
  call: FetchCall;
  file: SourceFile;
  node: AnyNode;
  role: Role;
  branches: Map<AnyNode, boolean | number[]>;
  inlineMiddleware: boolean;
  label: string;
}

interface PageMeta {
  layout: string | false | null | undefined;
  middleware: string[];
}

export const noSsrRefetchOfSharedKey = createRule({
  meta: {
    id: RULE_ID,
    title: "Share data fetched by several callers in one server render",
    category: "fetching",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/api/composables/use-async-data#params",
    execution: "workspace",
    cacheScope: "none",
    requires: { nuxt: true, crossFile: true },
    requiresContext: ["cross-file"],
    consumesEvidence: ["ast", "graph"],
    cost: "medium",
  },
  create(ctx) {
    return {
      async onWorkspaceEnd() {
        const nuxt = ctx.project.nuxt;
        if (!nuxt || nuxt.ssr === false) return;
        await new SharedKeyAnalysis(ctx).run();
      },
    };
  },
});

class SharedKeyAnalysis {
  private files = new Map<string, SourceFile | null>();
  private displayPaths = new Map<string, string>();
  private texts = new Map<string, string>();
  private factories = new Map<string, Factory>();
  private composables = new Map<string, FetchCall[]>();
  private calls: FetchCall[] = [];
  private sites: CallSite[] = [];
  private pageMeta = new Map<string, PageMeta>();
  private roots: string[];
  private layoutsStatic = true;
  private layoutsRender = true;
  private componentRoots = new Map<string, Set<string>>();

  constructor(private ctx: RuleContext) {
    const nuxt = ctx.project.nuxt!;
    const roots = new Set<string>([nuxt.appDir]);
    for (const layer of nuxt.layers ?? [])
      if (layer.srcDir) roots.add(resolve(ctx.project.root, layer.srcDir));
    this.roots = [...roots].sort((a, b) => b.length - a.length);
  }

  async run() {
    const entries = await selectScanFiles(this.ctx.project.root, {}, {}, this.ctx.project);
    const appFiles: string[] = [];
    for (const entry of entries) {
      if (entry.sourceKind === "module") continue;
      if (!entry.path.endsWith(".vue") && !SCRIPT_RE.test(entry.path)) continue;
      if (/\.d\.[cm]?ts$/.test(entry.path)) continue;
      const text = this.ctx.fs.readText(entry.path);
      if (text === undefined) continue;
      this.texts.set(entry.path, text);
      this.displayPaths.set(entry.path, entry.displayPath);
      appFiles.push(entry.path);
    }
    this.layoutsStatic =
      ![...this.texts.values()].some((text) => text.includes("setPageLayout")) &&
      !JSON.stringify(this.ctx.project.nuxt?.routeRules ?? {}).includes("appLayout");
    const appVue = this.roots
      .map((root) => resolve(root, "app.vue"))
      .find((file) => this.texts.has(file));
    this.layoutsRender = !appVue || /<(?:NuxtLayout|nuxt-layout)\b/.test(this.texts.get(appVue)!);

    for (const path of appFiles) {
      if (!SCRIPT_RE.test(path) || !/createUse(?:Fetch|AsyncData)/.test(this.texts.get(path)!))
        continue;
      const file = await this.load(path);
      if (file) this.collectFactories(file);
    }
    const factoryNames = [...this.factories.keys()].map((id) => id.split("#")[1]!);
    const dataCalls = mentions([...FETCH_CALLS, ...ASYNC_DATA_CALLS, ...factoryNames]);
    for (const path of appFiles) {
      if (!SCRIPT_RE.test(path) || !dataCalls.test(this.texts.get(path)!)) continue;
      const file = await this.load(path);
      if (file) this.collectComposables(file);
    }
    const composableNames = [...this.composables.keys()].map((id) => id.split("#")[1]!);
    const callers = mentions([
      ...FETCH_CALLS,
      ...ASYNC_DATA_CALLS,
      ...factoryNames,
      ...composableNames,
    ]);
    for (const path of appFiles) {
      const app = this.appFile(path);
      if (!app || !callers.test(this.texts.get(path)!)) continue;
      const file = await this.load(path);
      if (file) this.collectCallSites(file, app);
    }
    await this.report();
  }

  private async load(path: string): Promise<SourceFile | null> {
    if (this.files.has(path)) return this.files.get(path)!;
    const text = this.texts.get(path) ?? this.ctx.fs.readText(path);
    let file: SourceFile | null = null;
    if (text !== undefined) {
      try {
        file = path.endsWith(".vue") ? await parseVue(path, text) : parseTs(path, text);
        if (file)
          file.displayPath = this.displayPaths.get(path) ?? relative(this.ctx.project.root, path);
      } catch {
        file = null;
      }
    }
    this.files.set(path, file);
    return file;
  }

  private appFile(path: string): AppFile | null {
    if (/\.(?:client|server)\.[^/]+$/.test(path)) return null;
    for (const root of this.roots) {
      const rel = relative(root, path);
      if (rel.startsWith("..")) continue;
      if (rel === "app.vue") return { role: "app" };
      if (/^pages\/.+\.(?:vue|[jt]sx)$/.test(rel)) return { role: "page" };
      const layout = rel.match(/^layouts\/(.+)\.vue$/);
      if (layout) return { role: "layout", name: layoutName(layout[1]!) };
      if (/^components\/.+\.vue$/.test(rel)) return { role: "component" };
      const middleware = rel.match(/^middleware\/([^/]+?)(?:\/index)?\.[cm]?[jt]s$/);
      if (middleware) {
        const global = middleware[1]!.endsWith(".global");
        return {
          role: "middleware",
          global,
          name: global ? undefined : middleware[1],
        };
      }
      if (/^plugins\/(?:[^/]+|[^/]+\/index)\.[cm]?[jt]s$/.test(rel)) return { role: "plugin" };
      return null;
    }
    return null;
  }

  private collectFactories(file: SourceFile) {
    for (const [name, { init }] of file.moduleBindings) {
      const call = unwrap(init);
      if (call?.type !== "CallExpression") continue;
      const callee = calleeName(call);
      if (!callee || !FACTORY_CALLS.has(callee) || !this.isNuxt(file, callee)) continue;
      const options = unwrap(call.arguments?.[0]) ?? null;
      const param = FUNCTION_TYPES.has(options?.type) ? options.params?.[0] : undefined;
      this.factories.set(`${withoutExtension(file.path)}#${name}`, {
        kind: callee === "createUseFetch" ? "fetch" : "asyncData",
        text: file.text,
        options,
        param: param?.type === "Identifier" ? param.name : undefined,
      });
    }
  }

  private collectComposables(file: SourceFile) {
    for (const exported of exportedFunctions(file.program)) {
      const locals = functionLocals(exported.fn);
      const found: FetchCall[] = [];
      walkServer(file.text, exported.fn.body, (node) => {
        if (node.type !== "CallExpression") return;
        const call = this.fetchCall(file, node, (expression) =>
          isConstant(expression, file, locals),
        );
        if (call) found.push({ ...call, composable: exported.name });
      });
      if (found.length)
        this.composables.set(`${withoutExtension(file.path)}#${exported.name}`, found);
    }
  }

  /** A Nuxt data call whose key does not change between calls, with its option verdict. */
  private fetchCall(
    file: SourceFile,
    node: AnyNode,
    constant: (node: AnyNode) => boolean,
  ): FetchCall | null {
    const callee = calleeName(node);
    if (!callee) return null;
    const target = this.resolve(file, callee);
    let kind: "fetch" | "asyncData" | undefined;
    let factory: Factory | undefined;
    const nuxtName =
      target && "nuxt" in target ? target.nuxt : target && "auto" in target ? target.auto : null;
    if (nuxtName && FETCH_CALLS.has(nuxtName)) kind = "fetch";
    else if (nuxtName && ASYNC_DATA_CALLS.has(nuxtName)) kind = "asyncData";
    else {
      factory = this.lookup(this.factories, target);
      kind = factory?.kind;
    }
    if (!kind) return null;
    const args = node.arguments ?? [];
    let keyNode: AnyNode;
    let optionsNode: AnyNode;
    if (kind === "fetch") {
      optionsNode = args[1];
      const options = unwrap(optionsNode);
      if (options && options.type !== "ObjectExpression") return null;
      keyNode = property(options, "key");
      if (!keyNode) {
        if (!constant(args[0])) return null;
        for (const name of FETCH_KEY_OPTIONS) {
          const value = property(options, name);
          if (value && !constant(value)) return null;
        }
        if (factory && !factoryKeepsKey(factory)) return null;
      } else if (!constant(keyNode)) return null;
    } else {
      const first = unwrap(args[0]);
      if (FUNCTION_TYPES.has(first?.type)) {
        optionsNode = args[1];
      } else {
        keyNode = args[0];
        if (!constant(keyNode)) return null;
        optionsNode = args[2];
      }
    }
    const literal = keyNode ? staticString(keyNode) : null;
    const groupKey =
      literal !== null ? `key:${literal}` : `call:${file.path}:${node.start}:${node.end}`;
    const keyLabel = keyNode
      ? file.text.slice(keyNode.start, keyNode.end)
      : `the key Nuxt generates for ${callee}() here`;
    return {
      groupKey,
      keyLabel,
      file,
      node,
      callee,
      verdict: optionVerdict(file.text, unwrap(optionsNode), factory),
      factory,
    };
  }

  private collectCallSites(file: SourceFile, app: AppFile) {
    const contexts: Array<{ body: AnyNode; inlineMiddleware: boolean }> = [];
    if (file.vue) {
      if (file.setup) {
        const statements = (file.program.body ?? []).filter(
          (statement: AnyNode) =>
            statement.start >= file.setup!.start && statement.end <= file.setup!.end,
        );
        contexts.push({ body: statements, inlineMiddleware: false });
        if (app.role === "page") {
          const meta = this.readPageMeta(file, statements);
          for (const middleware of meta.inline)
            contexts.push({ body: middleware, inlineMiddleware: true });
        }
      }
      const setup = optionsSetup(file);
      if (setup) contexts.push({ body: setup, inlineMiddleware: false });
    } else {
      const body = defaultExportBody(file, app.role);
      if (body) contexts.push({ body, inlineMiddleware: false });
    }
    for (const context of contexts) {
      walkServer(file.text, context.body, (node, branches) => {
        if (node.type !== "CallExpression") return;
        const callee = calleeName(node);
        if (!callee) return;
        const site = {
          branches,
          file,
          node,
          role: context.inlineMiddleware ? ("middleware" as const) : app.role,
          inlineMiddleware: context.inlineMiddleware,
          label: siteLabel(app, context.inlineMiddleware),
        };
        const composable = this.lookup(this.composables, this.resolve(file, callee));
        if (composable) {
          for (const call of composable) this.sites.push({ ...site, call });
          return;
        }
        const direct = this.fetchCall(
          file,
          node,
          (expression) => staticString(expression) !== null,
        );
        if (direct?.groupKey.startsWith("key:")) {
          this.calls.push(direct);
          this.sites.push({ ...site, call: direct });
        }
      });
    }
  }

  private readPageMeta(file: SourceFile, statements: AnyNode[]) {
    const inline: AnyNode[] = [];
    const meta: PageMeta = { layout: undefined, middleware: [] };
    for (const statement of statements) {
      const call = unwrap(statement.type === "ExpressionStatement" ? statement.expression : null);
      if (call?.type !== "CallExpression" || calleeName(call) !== "definePageMeta") continue;
      const options = unwrap(call.arguments?.[0]);
      if (options?.type !== "ObjectExpression") {
        meta.layout = null;
        continue;
      }
      const layout = property(options, "layout");
      if (layout) {
        const value = unwrap(layout);
        meta.layout =
          value?.type === "Literal" && value.value === false ? false : staticString(value);
      } else if (options.properties.some((item: AnyNode) => item.type === "SpreadElement")) {
        meta.layout = null;
      }
      const middleware = unwrap(property(options, "middleware"));
      for (const item of middleware?.type === "ArrayExpression"
        ? middleware.elements
        : [middleware]) {
        const value = unwrap(item);
        if (FUNCTION_TYPES.has(value?.type)) inline.push(value.body);
        const name = value ? staticString(value) : null;
        if (name) meta.middleware.push(name);
      }
    }
    this.pageMeta.set(file.path, meta);
    return { ...meta, inline };
  }

  private async metaFor(page: string): Promise<PageMeta> {
    const known = this.pageMeta.get(page);
    if (known) return known;
    const file = await this.load(page);
    const statements = file?.setup
      ? (file.program.body ?? []).filter(
          (statement: AnyNode) =>
            statement.start >= file.setup!.start && statement.end <= file.setup!.end,
        )
      : [];
    if (!file) return { layout: null, middleware: [] };
    return this.readPageMeta(file, statements);
  }

  private allPageMeta = false;

  /** Reads every page's definePageMeta, to find the pages that run a named middleware. */
  private async loadAllPageMeta() {
    if (this.allPageMeta) return;
    this.allPageMeta = true;
    for (const [path, text] of this.texts)
      if (this.appFile(path)?.role === "page" && text.includes("definePageMeta"))
        await this.metaFor(path);
  }

  private async layoutOf(page: string): Promise<string | null> {
    if (!this.layoutsStatic || !this.layoutsRender) return null;
    const layout = (await this.metaFor(page)).layout;
    if (layout === undefined) return "default";
    return typeof layout === "string" ? layoutName(layout) : null;
  }

  private resolve(file: SourceFile, name: string): Target {
    const imported = file.imports.get(name);
    if (imported) {
      if (imported.source === "#imports") return this.autoImport(imported.imported);
      if (NUXT_SOURCE_RE.test(imported.source)) return { nuxt: imported.imported };
      const path = this.resolveModule(file.path, imported.source);
      return path ? { file: path, name: imported.imported } : null;
    }
    if (file.moduleBindings.has(name)) return { file: withoutExtension(file.path), name };
    if (file.shadowed.has(name)) return null;
    return this.autoImport(name);
  }

  private autoImport(name: string): Target {
    const nuxt = this.ctx.project.nuxt!;
    if (!nuxt.autoImportEnabled) return null;
    const entry = nuxt.autoImports.get(name);
    if (entry) {
      if (NUXT_SOURCE_RE.test(entry.from)) return { nuxt: entry.name };
      const path = this.resolveModule(this.ctx.project.root, entry.from);
      return path ? { file: path, name: entry.name } : null;
    }
    return nuxt.autoImportsAuthoritative ? null : { auto: name };
  }

  private resolveModule(from: string, source: string): string | null {
    const nuxt = this.ctx.project.nuxt!;
    const base = source.startsWith(".") ? dirname(from) : null;
    let path: string | null = null;
    if (base) path = resolve(base, source);
    else if (source.startsWith("/")) path = source;
    else if (/^[~@]\//.test(source)) path = resolve(nuxt.appDir, source.slice(2));
    else if (/^(?:~~|@@)\//.test(source)) path = resolve(this.ctx.project.root, source.slice(3));
    return path ? withoutExtension(path) : null;
  }

  private lookup<T>(map: Map<string, T>, target: Target): T | undefined {
    if (!target || "nuxt" in target) return undefined;
    if ("file" in target)
      return (
        map.get(`${target.file}#${target.name}`) ?? map.get(`${target.file}/index#${target.name}`)
      );
    // Without an authoritative manifest, a name resolves only to a unique export in a directory
    // Nuxt auto-imports from.
    const matches = [...map.entries()].filter(([id]) => {
      const [path, name] = id.split("#");
      return name === target.auto && this.isAutoImportDir(path!);
    });
    return matches.length === 1 ? matches[0]![1] : undefined;
  }

  private isAutoImportDir(path: string) {
    return this.roots.some((root) =>
      /^(?:composables|utils)\/(?:[^/]+|[^/]+\/index)$/.test(relative(root, path)),
    );
  }

  private isNuxt(file: SourceFile, name: string) {
    const target = this.resolve(file, name);
    return Boolean(target && ("nuxt" in target || "auto" in target));
  }

  private async rootsOf(site: CallSite): Promise<Set<string>> {
    const app = this.appFile(site.file.path)!;
    if (site.inlineMiddleware) return new Set([`page:${site.file.path}`]);
    if (app.role === "app" || app.role === "plugin" || (app.role === "middleware" && app.global))
      return new Set([ALL]);
    if (app.role === "page") return new Set([`page:${site.file.path}`]);
    if (app.role === "layout")
      return this.layoutsRender ? new Set([`layout:${app.name}`]) : new Set();
    if (app.role === "middleware") return new Set([`middleware:${app.name}`]);
    return this.renderRoots(site.file.path);
  }

  /** The pages, layouts, and app.vue that render a component during SSR, through other components. */
  private async renderRoots(component: string): Promise<Set<string>> {
    const known = this.componentRoots.get(component);
    if (known) return known;
    const roots = new Set<string>();
    this.componentRoots.set(component, roots);
    const graph = await this.ctx.inventory.componentUsage();
    const callers = [...(graph.components.get(component)?.callers ?? [])];
    if (!hasComponentEntries(this.ctx)) {
      const name = this.componentName(component);
      if (name)
        callers.push(
          ...graph.unresolved.filter((edge) => tagComponentName(edge.usage.tag) === name),
        );
    }
    for (const edge of callers) {
      const renderer = await this.load(edge.from);
      if (
        !renderer ||
        insideClientOnly(renderer, edge.usage.range.start) ||
        renderer.conditionalRanges.some(
          ([start, end]) => edge.usage.range.start >= start && edge.usage.range.start < end,
        )
      )
        continue;
      const app = this.appFile(edge.from);
      if (app?.role === "app") roots.add(ALL);
      else if (app?.role === "page") roots.add(`page:${edge.from}`);
      else if (app?.role === "layout" && this.layoutsRender) roots.add(`layout:${app.name}`);
      else if (app?.role === "component")
        for (const root of await this.renderRoots(edge.from)) roots.add(root);
    }
    return roots;
  }

  /**
   * The name Nuxt's default `components/` directories register for a file. Doctor's component
   * graph resolves auto-imported tags only from manifest component entries, so without them the
   * Rule falls back to Nuxt's naming for the default directories.
   */
  private componentName(path: string): string | null {
    for (const root of this.roots) {
      const rel = relative(resolve(root, "components"), path);
      if (rel.startsWith("..")) continue;
      const scoped = rel.startsWith("global/") ? rel.slice(7) : rel;
      const parts = scoped.split("/");
      const fileName = parts
        .pop()!
        .replace(/\.vue$/, "")
        .replace(/\.global$/, "");
      const prefixParts = parts.flatMap((part) => splitByCase(part));
      return componentNameSegments(fileName.toLowerCase() === "index" ? "" : fileName, prefixParts)
        .map(upperFirst)
        .join("");
    }
    return null;
  }

  /** Why two call sites can run during the same server render, or null when Doctor cannot tell. */
  private async coRendered(a: CallSite, b: CallSite): Promise<string | null> {
    if (
      a.file.path === b.file.path &&
      [...a.branches].some(([branch, side]) => {
        const other = b.branches.get(branch);
        return (
          other !== undefined &&
          (Array.isArray(side) && Array.isArray(other)
            ? !side.some((entry) => other.includes(entry))
            : side !== other)
        );
      })
    )
      return null;
    if (a.file.path === b.file.path && (a.role !== "layout" || this.layoutsRender))
      return `both run in ${a.file.displayPath}`;
    const [left, right] = [await this.rootsOf(a), await this.rootsOf(b)];
    if (!left.size || !right.size) return null;
    for (const [site, roots] of [
      [a, left],
      [b, right],
    ] as const)
      if (roots.has(ALL)) return `${site.file.displayPath} runs on every server render`;
    for (const root of left)
      if (right.has(root)) return `both render under ${this.describeRoot(root)}`;
    for (const [one, other] of [
      [left, right],
      [right, left],
    ]) {
      for (const root of one) {
        if (!root.startsWith("page:")) continue;
        const page = root.slice(5);
        const meta = await this.metaFor(page);
        const layout = await this.layoutOf(page);
        for (const candidate of other) {
          if (layout && candidate === `layout:${layout}`)
            return `${this.display(page)} renders in layout "${layout}"`;
          if (candidate.startsWith("middleware:") && meta.middleware.includes(candidate.slice(11)))
            return `${this.display(page)} runs middleware "${candidate.slice(11)}"`;
        }
      }
    }
    for (const [one, other] of [
      [left, right],
      [right, left],
    ]) {
      for (const layout of [...one].filter((root) => root.startsWith("layout:"))) {
        await this.loadAllPageMeta();
        for (const middleware of [...other].filter((root) => root.startsWith("middleware:"))) {
          for (const [page, meta] of this.pageMeta) {
            if (
              meta.middleware.includes(middleware.slice(11)) &&
              `layout:${await this.layoutOf(page)}` === layout
            )
              return `${this.display(page)} runs middleware "${middleware.slice(11)}" in layout "${layout.slice(7)}"`;
          }
        }
      }
    }
    return null;
  }

  private describeRoot(root: string) {
    if (root.startsWith("page:")) return this.display(root.slice(5));
    if (root.startsWith("layout:")) return `layout "${root.slice(7)}"`;
    return `middleware "${root.slice(11)}"`;
  }

  private display(path: string) {
    return this.displayPaths.get(path) ?? relative(this.ctx.project.root, path);
  }

  private async report() {
    const calls = [...[...this.composables.values()].flat(), ...this.calls];
    const groups = new Map<string, { calls: FetchCall[]; sites: CallSite[] }>();
    for (const call of calls) {
      const group = groups.get(call.groupKey) ?? { calls: [], sites: [] };
      group.calls.push(call);
      groups.set(call.groupKey, group);
    }
    for (const site of this.sites) groups.get(site.call.groupKey)?.sites.push(site);

    for (const group of groups.values()) {
      if (group.calls.some((call) => call.verdict === "unknown")) continue;
      const fetching = new Set(group.calls.filter((call) => call.verdict !== null));
      const sites = uniqueSites(group.sites.filter((site) => fetching.has(site.call)));
      if (sites.length < 2 || !fetching.size) continue;
      const reasons: string[] = [];
      const involved = new Set<CallSite>();
      for (let i = 0; i < sites.length; i++) {
        for (let j = i + 1; j < sites.length; j++) {
          const reason = await this.coRendered(sites[i]!, sites[j]!);
          if (!reason) continue;
          involved.add(sites[i]!).add(sites[j]!);
          if (!reasons.includes(reason)) reasons.push(reason);
        }
      }
      if (
        involved.size < 2 ||
        ![...involved].some((site) => !(site.call.verdict as OptionVerdict).cached)
      )
        continue;
      this.reportGroup([...fetching], [...involved], reasons);
    }
  }

  private groupFix(calls: FetchCall[], location: (path: string, at: SourceRange) => string) {
    const cached = calls.filter((call) => (call.verdict as OptionVerdict).cached);
    const reference =
      cached.map((call) => (call.verdict as OptionVerdict).cacheReference).find(Boolean) ??
      "sharedSsrCachedData";
    const introduction = cached.length
      ? `Reuse the existing getCachedData implementation as ${reference}: export/import that same function binding wherever needed. Preserve existing cache properties; if a callback is inline, extract it to this binding and replace its value without adding another property.`
      : `Define and export one shared binding, const ${reference} = ${CACHE_FIX}; import it wherever needed.`;
    const fixes = calls
      .filter((call) => {
        const verdict = call.verdict as OptionVerdict;
        return !verdict.cached || verdict.cacheReference !== reference || !verdict.defer;
      })
      .map((call) => {
        const verdict = call.verdict as OptionVerdict;
        const at = this.ctx.helpers.rangeFromOffsets(
          call.file.path,
          call.file.text,
          call.node.start,
          call.node.end,
        );
        const fix = verdict.cached
          ? `${verdict.cacheReference === reference ? "Keep getCachedData unchanged" : `Replace the existing getCachedData value with ${reference} (do not add another property)`}${verdict.defer ? "." : ` and set dedupe to 'defer' on the server only${call.factory?.param ? ` (use ${call.factory.param}.dedupe ?? 'defer' in the factory)` : ""}.`}`
          : fixFor(call, verdict.defer, reference);
        return `${location(call.file.displayPath, at)}: ${fix}`;
      });
    return `${introduction} Apply consistent options to every same-key definition: ${fixes.join(" ")} Use the same getCachedData function reference for all definitions sharing this key, preserving Nuxt's option consistency contract.`;
  }

  private reportGroup(calls: FetchCall[], sites: CallSite[], reasons: string[]) {
    sites.sort(
      (a, b) =>
        ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) ||
        a.file.displayPath.localeCompare(b.file.displayPath) ||
        a.node.start - b.node.start,
    );
    const primary =
      calls.find((call) => call.composable && !(call.verdict as OptionVerdict).cached) ??
      calls.find(
        (call) => call.node === sites[0]!.node && !(call.verdict as OptionVerdict).cached,
      ) ??
      calls.find((call) => !(call.verdict as OptionVerdict).cached) ??
      calls[0]!;
    const defer = calls.every((call) => (call.verdict as OptionVerdict).defer);
    const name = primary.composable ? `${primary.composable}()` : `${primary.callee}()`;
    const where = sites
      .slice(0, 4)
      .map((site) => `${site.file.displayPath} (${site.label})`)
      .join(", ");
    const more = sites.length > 4 ? ` and ${sites.length - 4} more` : "";
    const mechanism = defer
      ? "dedupe: 'defer' only shares a request that is still in flight, so a caller that runs after the first request finished fetches again"
      : "a caller that runs after the first request finished fetches again, and the default dedupe: 'cancel' aborts and restarts a request that is still in flight";
    const text = primary.file.text;
    const range = this.ctx.helpers.rangeFromOffsets(
      primary.file.path,
      text,
      primary.node.start,
      primary.node.end,
    );
    const rangeOf = (site: CallSite) =>
      this.ctx.helpers.rangeFromOffsets(
        site.file.path,
        site.file.text,
        site.node.start,
        site.node.end,
      );
    const location = (path: string, at: SourceRange) => `${path}:${at.line}:${at.column}`;
    this.ctx.report(
      diagnostics.NUXT0095({
        why: `${name} fetches key ${primary.keyLabel}, and ${sites.length} callers can run during the same server render: ${where}${more}. During SSR, Nuxt's default getCachedData returns payload data only while hydrating in the browser, so ${mechanism}. Each caller adds a request to the render.`,
        fix: calls.length === 1 ? fixFor(primary, defer) : this.groupFix(calls, location),
        sources: [
          location(primary.file.displayPath, range),
          ...sites
            .slice(0, MAX_RELATED)
            .map((site) => location(site.file.displayPath, rangeOf(site))),
        ],
      }),
      {
        ruleId: RULE_ID,
        severity: this.ctx.severity,
        category: "fetching",
        file: primary.file.path,
        range,
        confidence: "heuristic-high",
        related: sites.slice(0, MAX_RELATED).map((site) => ({
          file: site.file.path,
          range: rangeOf(site),
          message: `Calls ${site.call.composable ?? site.call.callee}() during SSR (${site.label})`,
        })),
        evidence: [
          {
            kind: "ast",
            file: primary.file.path,
            range,
            summary: `${primary.callee}() fetches during SSR without getCachedData${defer ? "" : " or dedupe: 'defer'"}, with a key that does not change between calls.`,
          },
          ...reasons.slice(0, 4).map((reason) => ({
            kind: "graph" as const,
            summary: `Same server render: ${reason}.`,
          })),
        ],
      },
    );
  }
}

const ROLE_ORDER: Role[] = ["plugin", "middleware", "app", "layout", "page", "component"];

function fixFor(call: FetchCall, defer: boolean, cache = CACHE_FIX): string {
  const options = defer ? `getCachedData: ${cache}` : `dedupe: 'defer' and getCachedData: ${cache}`;
  const factory = call.factory;
  if (factory && FUNCTION_TYPES.has(factory.options?.type)) {
    const param = factory.param ?? "defaults";
    return `Add ${defer ? "" : `dedupe: ${param}.dedupe ?? 'defer' and `}getCachedData: ${param}.getCachedData ?? (${cache}) to the server options this ${call.callee} factory returns${factory.param ? "" : ` (name its first parameter ${param})`}. Options a factory function returns override the caller's, so the ?? fallbacks keep caller overrides. Callers in one render then share the first request and its result; refresh() still fetches because its cause is not 'initial'.`;
  }
  return `Pass ${options} on the server only, for example \`...(import.meta.server && { ${defer ? "" : "dedupe: 'defer', "}getCachedData: ${cache} })\`. Callers in one render then share the first request and its result, and refresh() still fetches because its cause is not 'initial'. Keeping it off the client preserves Nuxt's default caching after hydration.`;
}

function siteLabel(app: AppFile, inlineMiddleware: boolean) {
  if (inlineMiddleware) return "inline page middleware";
  if (app.role === "middleware") return app.global ? "global route middleware" : "route middleware";
  if (app.role === "app") return "app.vue";
  return app.role;
}

function uniqueSites(sites: CallSite[]) {
  const seen = new Set<string>();
  return sites.filter((site) => {
    const id = `${site.file.path}:${site.node.start}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// Mirrors resolveComponentNameSegments in Nuxt's component scanner: a file name that repeats its
// directory prefix drops the duplicate, so components/viewer/ViewerFolder.vue is ViewerFolder.
function componentNameSegments(fileName: string, prefixParts: string[]): string[] {
  const fileNameParts = splitByCase(fileName);
  const content = fileNameParts.join("/").toLowerCase();
  const nameParts = [...prefixParts];
  const matched: string[] = [];
  for (let index = prefixParts.length - 1; index >= 0; index--) {
    const part = prefixParts[index]!;
    matched.unshift(part.toLowerCase());
    const suffix = matched.join("/");
    if (
      content === suffix ||
      content.startsWith(`${suffix}/`) ||
      (part.toLowerCase() === content && prefixParts[index + 1] === part)
    )
      nameParts.length = index;
  }
  return [...nameParts, ...fileNameParts];
}

function splitByCase(value: string): string[] {
  return value
    .split(/[-_/.]+/)
    .flatMap((part) => part.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z0-9]+/g) ?? []);
}

// Manifests that record Nuxt's component directories instead of resolved components carry no
// entry with a name and file, so the component graph cannot resolve auto-imported tags.
function hasComponentEntries(ctx: RuleContext) {
  return [...(ctx.project.nuxt?.components.values() ?? [])].some(
    (entry) => typeof entry?.name === "string" && typeof entry.file === "string",
  );
}

function upperFirst(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function tagComponentName(tag: string) {
  return tag
    .split("-")
    .map(upperFirst)
    .join("")
    .replace(/^Lazy(?=[A-Z])/, "");
}

function mentions(names: string[]) {
  const escaped = [...new Set(names)].map((name) => name.replace(/[$]/g, "\\$&"));
  return new RegExp(`\\b(?:${escaped.join("|")})\\b`);
}

function layoutName(path: string) {
  return path
    .split("/")
    .map((part) => part.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase())
    .join("-");
}

/**
 * The verdict for the options a call resolves: null when the call never fetches during SSR,
 * "unknown" when an unresolved spread or a dynamic flag decides it.
 */
function optionVerdict(
  text: string,
  options: AnyNode,
  factory: Factory | undefined,
): OptionVerdict | null | "unknown" {
  if (options && options.type !== "ObjectExpression") return "unknown";
  const layers: AnyNode[][] = [];
  const factoryOptions = unwrap(factory?.options);
  let factoryObjects: AnyNode[] | null = [];
  if (factoryOptions) {
    if (factoryOptions.type === "ObjectExpression") factoryObjects = [factoryOptions];
    else if (FUNCTION_TYPES.has(factoryOptions.type))
      factoryObjects = serverReturns(text, factoryOptions);
    else factoryObjects = null;
  }
  if (!factoryObjects) return "unknown";
  // Nuxt merges a factory object under the call's options; a factory function's result wins.
  const own = options ? [options] : [];
  if (FUNCTION_TYPES.has(factoryOptions?.type)) layers.push(own, factoryObjects);
  else layers.push(factoryObjects, own);
  const objects = layers.flat();
  // Understand the server-only object spread prescribed by this rule.
  for (let i = 0; i < objects.length; i++) {
    const object = objects[i]!;
    const properties: AnyNode[] = [];
    for (const item of object.properties) {
      const value = unwrap(item.argument);
      if (
        item.type === "SpreadElement" &&
        value?.type === "LogicalExpression" &&
        value.operator === "&&" &&
        guardOf(text, value.left) === "server" &&
        unwrap(value.right)?.type === "ObjectExpression"
      ) {
        objects.push(unwrap(value.right));
      } else properties.push(item);
    }
    objects[i] = { ...object, properties };
  }
  if (objects.some((object) => object.properties.some((item: AnyNode) => item.type !== "Property")))
    return "unknown";
  const cached = objects.some((object) => property(object, "getCachedData"));
  for (const flag of ["server", "immediate", "enabled"]) {
    for (const object of objects) {
      const value = unwrap(property(object, flag));
      if (!value) continue;
      if (value.type === "Literal" && value.value === false) return null;
      if (!(value.type === "Literal" && value.value === true)) return "unknown";
    }
  }
  const dedupe = objects
    .map((object) => property(object, "dedupe"))
    .filter(Boolean)
    .map(isDeferDedupe);
  const cache = unwrap(
    objects
      .map((object) => property(object, "getCachedData"))
      .filter(Boolean)
      .at(-1),
  );
  return {
    defer: dedupe.length > 0 && dedupe.every(Boolean),
    cached,
    cacheReference: cache?.type === "Identifier" ? cache.name : undefined,
  };
}

function isDeferDedupe(node: AnyNode): boolean {
  const value = unwrap(node);
  if (staticString(value) === "defer") return true;
  return (
    value?.type === "LogicalExpression" &&
    ["??", "||"].includes(value.operator) &&
    staticString(value.right) === "defer"
  );
}

/** Object literals a factory function returns on the server; null when one is not a literal. */
function serverReturns(text: string, fn: AnyNode): AnyNode[] | null {
  const body = unwrap(fn.body);
  if (body?.type !== "BlockStatement") return body?.type === "ObjectExpression" ? [body] : null;
  const objects: AnyNode[] = [];
  let unknown = false;
  walkServer(text, body.body, (node) => {
    if (node.type !== "ReturnStatement") return;
    const value = unwrap(node.argument);
    if (value?.type === "ObjectExpression") objects.push(value);
    else unknown = true;
  });
  return unknown ? null : objects;
}

/** A factory whose server options never add a key or key-shaping option of their own. */
function factoryKeepsKey(factory: Factory): boolean {
  const options = unwrap(factory.options);
  if (!options) return true;
  const objects =
    options.type === "ObjectExpression"
      ? [options]
      : FUNCTION_TYPES.has(options.type)
        ? (serverReturns(factory.text, options) ?? [])
        : [];
  return objects.every(
    (object) => !["key", ...FETCH_KEY_OPTIONS].some((name) => property(object, name)),
  );
}

type Guard = "client" | "server" | "mixed" | null;

const CLIENT_FLAG =
  /^(?:import\.meta\.(?:client|browser)|process\.(?:client|browser)|!(?:import\.meta|process)\.server)$/;
const SERVER_FLAG =
  /^(?:import\.meta\.server|process\.server|!(?:import\.meta\.(?:client|browser)|process\.(?:client|browser)))$/;
const ANY_FLAG = /(?:import\.meta|process)\.(?:client|server|browser)/;

function guardOf(text: string, test: AnyNode): Guard {
  const source = text.slice(test.start, test.end).replace(/[\s()]/g, "");
  if (CLIENT_FLAG.test(source)) return "client";
  if (SERVER_FLAG.test(source)) return "server";
  return ANY_FLAG.test(source) ? "mixed" : null;
}

/**
 * Visits nodes that run when the body runs during SSR. Nested functions run later or not at all,
 * and branches behind a client or mixed import.meta guard may not run on the server.
 */
function walkServer(
  text: string,
  node: AnyNode,
  visit: (node: AnyNode, branches: Map<AnyNode, boolean | number[]>) => void,
  branches = new Map<AnyNode, boolean | number[]>(),
) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const statement of node) {
      walkServer(text, statement, visit, branches);
      if (!completions(statement).has("normal")) return;
      if (statement?.type === "SwitchStatement") {
        const continuing = switchPaths(statement).continuing;
        if (!continuing.length) return;
        branches = new Map([...branches, [statement, continuing]]);
      }
      if (
        statement?.type === "IfStatement" &&
        !statement.alternate &&
        alwaysExits(statement.consequent)
      ) {
        const guard = guardOf(text, statement.test);
        if (guard === "server" || guard === "mixed") return;
      }
    }
    return;
  }
  if (typeof node.type !== "string") return;
  if (FUNCTION_TYPES.has(node.type) || node.type === "ClassBody") return;
  if (node.type.startsWith("TS") && !TS_EXPRESSIONS.has(node.type)) return;
  visit(node, branches);
  if (node.type === "IfStatement" || node.type === "ConditionalExpression") {
    const guard = guardOf(text, node.test);
    walkServer(text, node.test, visit, branches);
    if (guard !== "client" && guard !== "mixed")
      walkServer(text, node.consequent, visit, new Map([...branches, [node, true]]));
    if (guard !== "server" && guard !== "mixed")
      walkServer(text, node.alternate, visit, new Map([...branches, [node, false]]));
    return;
  }
  if (node.type === "SwitchStatement") {
    walkServer(text, node.discriminant, visit, branches);
    const { entries } = switchPaths(node);
    node.cases.forEach((item: AnyNode, index: number) => {
      walkServer(text, item.consequent, visit, new Map([...branches, [node, entries[index]!]]));
    });
    return;
  }
  if (node.type === "LogicalExpression") {
    const guard = guardOf(text, node.left);
    walkServer(text, node.left, visit, branches);
    const rightRuns =
      guard === null ||
      (node.operator === "&&" && guard === "server") ||
      (node.operator === "||" && guard === "client");
    if (rightRuns) walkServer(text, node.right, visit, branches);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "__doctorParent" || key === "parent" || key === "typeAnnotation") continue;
    if (value && typeof value === "object") walkServer(text, value, visit, branches);
  }
}

const TS_EXPRESSIONS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
]);

/** Possible switch entry labels for each body and for code after the switch. */
function switchPaths(node: AnyNode): { entries: number[][]; continuing: number[] } {
  const entries: number[][] = [];
  const continuing: number[] = node.cases.some((item: AnyNode) => !item.test) ? [] : [-1];
  let active: number[] = [];
  node.cases.forEach((item: AnyNode, index: number) => {
    active = [...active, index];
    entries.push(active);
    const outcomes = completions(item.consequent);
    if (outcomes.has("break")) continuing.push(...active);
    if (!outcomes.has("normal")) active = [];
  });
  return { entries, continuing: [...continuing, ...active] };
}

type Completion = "normal" | "break" | "exit";

/** Possible ways a statement finishes; nested switches consume their own breaks. */
function completions(node: AnyNode): Set<Completion> {
  if (!node) return new Set(["normal"]);
  if (Array.isArray(node)) {
    const result = new Set<Completion>(["normal"]);
    for (const statement of node) {
      if (!result.delete("normal")) break;
      for (const outcome of completions(statement)) result.add(outcome);
    }
    return result;
  }
  if (node.type === "ReturnStatement" || node.type === "ThrowStatement") return new Set(["exit"]);
  if (node.type === "BreakStatement" && !node.label) return new Set(["break"]);
  if (node.type === "BlockStatement") return completions(node.body);
  if (node.type === "IfStatement")
    return new Set([...completions(node.consequent), ...completions(node.alternate)]);
  if (node.type === "SwitchStatement") {
    const result = new Set<Completion>();
    if (!node.cases.some((item: AnyNode) => !item.test)) result.add("normal");
    let following = new Set<Completion>(["normal"]);
    for (const item of [...node.cases].reverse()) {
      const outcomes = completions(item.consequent);
      if (outcomes.delete("normal")) for (const outcome of following) outcomes.add(outcome);
      following = outcomes;
      for (const outcome of outcomes) result.add(outcome === "break" ? "normal" : outcome);
    }
    return result;
  }
  return new Set(["normal"]);
}

function alwaysExits(node: AnyNode): boolean {
  if (!node) return false;
  if (node.type === "ReturnStatement" || node.type === "ThrowStatement") return true;
  if (node.type === "BlockStatement") return node.body.some(alwaysExits);
  if (node.type === "IfStatement")
    return alwaysExits(node.consequent) && alwaysExits(node.alternate);
  return false;
}

/** Whether a key or URL expression evaluates to the same value on every call of the composable. */
function isConstant(node: AnyNode, file: SourceFile, locals: Set<string>): boolean {
  const value = unwrap(node);
  if (!value) return false;
  switch (value.type) {
    case "Literal":
      return true;
    case "TemplateLiteral":
      return value.expressions.every((item: AnyNode) => isConstant(item, file, locals));
    case "BinaryExpression":
      return isConstant(value.left, file, locals) && isConstant(value.right, file, locals);
    case "MemberExpression":
      return (
        isConstant(value.object, file, locals) &&
        (!value.computed || isConstant(value.property, file, locals))
      );
    case "Identifier": {
      if (locals.has(value.name)) return false;
      if (file.imports.has(value.name)) return true;
      const binding = file.moduleBindings.get(value.name);
      if (!binding) return !file.shadowed.has(value.name);
      const init = unwrap(binding.init);
      return (
        binding.constant &&
        ["Literal", "TemplateLiteral", "ObjectExpression", "ArrayExpression"].includes(init?.type)
      );
    }
    case "ObjectExpression":
      return value.properties.every(
        (item: AnyNode) =>
          item.type === "Property" && !item.computed && isConstant(item.value, file, locals),
      );
    default:
      return false;
  }
}

function functionLocals(fn: AnyNode): Set<string> {
  const names = new Set<string>();
  const visit = (node: AnyNode) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node.type !== "string") return;
    if (FUNCTION_TYPES.has(node.type))
      for (const param of node.params ?? [])
        for (const name of patternNames(param)) names.add(name);
    if (node.type === "VariableDeclarator")
      for (const name of patternNames(node.id)) names.add(name);
    for (const [key, value] of Object.entries(node))
      if (key !== "__doctorParent" && key !== "parent" && value && typeof value === "object")
        visit(value);
  };
  visit(fn);
  return names;
}

function property(object: AnyNode, name: string): AnyNode {
  if (object?.type !== "ObjectExpression") return null;
  let found: AnyNode = null;
  for (const item of object.properties ?? []) {
    if (item.type !== "Property") continue;
    const key = item.computed ? staticString(item.key) : (item.key?.name ?? item.key?.value);
    if (key === name) found = item.kind === "init" || !item.kind ? (item.value ?? null) : item;
  }
  return found;
}

function staticString(node: AnyNode): string | null {
  const value = unwrap(node);
  if (value?.type === "Literal" && typeof value.value === "string") return value.value;
  if (value?.type === "TemplateLiteral" && value.expressions.length === 0)
    return value.quasis[0]?.value?.cooked ?? null;
  return null;
}

function calleeName(call: AnyNode): string | null {
  const callee = unwrap(call.callee);
  return callee?.type === "Identifier" ? callee.name : null;
}

function unwrap(node: AnyNode): AnyNode {
  let current = node;
  while (
    current &&
    (TS_EXPRESSIONS.has(current.type) ||
      current.type === "ParenthesizedExpression" ||
      current.type === "ChainExpression" ||
      current.type === "AwaitExpression")
  )
    current = current.expression ?? current.argument;
  return current ?? null;
}

function withoutExtension(path: string) {
  return path.replace(/\.[^./]+$/, "");
}

function insideClientOnly(file: SourceFile, offset: number) {
  return file.clientOnlyRanges.some(([start, end]) => offset >= start && offset < end);
}

/** The body of the default-exported route middleware or plugin setup function. */
function defaultExportBody(file: SourceFile, role: Role): AnyNode {
  if (role !== "middleware" && role !== "plugin") return null;
  for (const statement of file.program.body ?? []) {
    if (statement.type !== "ExportDefaultDeclaration") continue;
    let value = unwrap(statement.declaration);
    if (value?.type === "Identifier") value = unwrap(file.moduleBindings.get(value.name)?.init);
    const define = role === "middleware" ? "defineNuxtRouteMiddleware" : "defineNuxtPlugin";
    if (value?.type === "CallExpression" && calleeName(value) === define)
      value = unwrap(value.arguments?.[0]);
    if (role === "plugin" && value?.type === "ObjectExpression")
      value = unwrap(property(value, "setup"));
    return FUNCTION_TYPES.has(value?.type) ? value.body : null;
  }
  return null;
}

/** The body of an Options API `setup()` in an SFC's default export. */
function optionsSetup(file: SourceFile): AnyNode {
  for (const statement of file.program.body ?? []) {
    if (statement.type !== "ExportDefaultDeclaration") continue;
    if (file.setup && statement.start >= file.setup.start) continue;
    let value = unwrap(statement.declaration);
    if (value?.type === "CallExpression" && calleeName(value) === "defineComponent")
      value = unwrap(value.arguments?.[0]);
    const setup = unwrap(property(value, "setup"));
    return FUNCTION_TYPES.has(setup?.type) ? setup.body : null;
  }
  return null;
}

function parseTs(path: string, text: string): SourceFile | null {
  const program = parseScript(path, text);
  return program ? describe(path, text, program, false) : null;
}

async function parseVue(path: string, text: string): Promise<SourceFile | null> {
  const sfc = await parseSfcFile(path, text);
  const descriptor = sfc.descriptor as any;
  const program = parseVueScripts(path, descriptor, text) ?? { type: "Program", body: [] };
  const file = describe(path, text, program, true);
  const setup = descriptor.scriptSetup?.loc;
  if (setup) file.setup = { start: setup.start.offset, end: setup.end.offset };
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (node.type === 1 && /^(?:ClientOnly|client-only)$/.test(node.tag))
      file.clientOnlyRanges.push([node.loc.start.offset, node.loc.end.offset]);
    // Conditional template edges do not prove co-rendering; exclude their descendants too.
    if (
      node.type === 1 &&
      node.props?.some(
        (prop: any) => prop.type === 7 && ["if", "else-if", "else"].includes(prop.name),
      )
    )
      file.conditionalRanges.push([node.loc.start.offset, node.loc.end.offset]);
    for (const child of node.children ?? []) visit(child);
  };
  visit(sfc.getTemplateAst());
  return file;
}

function describe(path: string, text: string, program: AnyNode, vue: boolean): SourceFile {
  const imports = new Map<string, { source: string; imported: string }>();
  const moduleBindings = new Map<string, { init: AnyNode; constant: boolean }>();
  for (const statement of program.body ?? []) {
    if (statement.type === "ImportDeclaration") {
      if (statement.importKind === "type") continue;
      for (const specifier of statement.specifiers ?? []) {
        if (specifier.importKind === "type" || !specifier.local?.name) continue;
        const imported =
          specifier.type === "ImportSpecifier"
            ? (specifier.imported?.name ?? specifier.imported?.value)
            : specifier.type === "ImportDefaultSpecifier"
              ? "default"
              : "*";
        imports.set(specifier.local.name, { source: statement.source.value, imported });
      }
      continue;
    }
    const declaration =
      statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
        ? statement.declaration
        : statement;
    if (declaration?.type === "FunctionDeclaration" && declaration.id)
      moduleBindings.set(declaration.id.name, { init: declaration, constant: true });
    if (declaration?.type === "ClassDeclaration" && declaration.id)
      moduleBindings.set(declaration.id.name, { init: null, constant: true });
    if (declaration?.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations ?? []) {
        const init = declarator.id.type === "Identifier" ? (declarator.init ?? null) : null;
        for (const name of patternNames(declarator.id))
          moduleBindings.set(name, { init, constant: declaration.kind === "const" });
      }
    }
  }
  const shadowed = new Set<string>();
  const visit = (node: AnyNode) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node.type !== "string") return;
    if (FUNCTION_TYPES.has(node.type)) {
      if (node.id?.name) shadowed.add(node.id.name);
      for (const param of node.params ?? [])
        for (const name of patternNames(param)) shadowed.add(name);
    }
    if (node.type === "VariableDeclarator")
      for (const name of patternNames(node.id)) shadowed.add(name);
    if (node.type === "CatchClause")
      for (const name of patternNames(node.param)) shadowed.add(name);
    for (const [key, value] of Object.entries(node))
      if (key !== "__doctorParent" && key !== "parent" && value && typeof value === "object")
        visit(value);
  };
  visit(program.body);
  return {
    path,
    displayPath: path,
    text,
    program,
    vue,
    clientOnlyRanges: [],
    conditionalRanges: [],
    imports,
    moduleBindings,
    shadowed,
  };
}
