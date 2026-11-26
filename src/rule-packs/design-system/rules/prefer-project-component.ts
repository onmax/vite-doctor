import { dirname, join, relative, resolve } from "pathe";
import {
  type ComponentNode,
  type ComponentUsageGraph,
  type Confidence,
  createRule,
  type NuxtProjectInfo,
  type ProjectInfo,
  type RuleContext,
  type RuleFileSystem,
  type ScriptAstNode,
  type TemplateElementNode,
  type TemplateRootNode,
} from "../../../core/index.js";
import { doctorInternalDiagnostics } from "../../../core/internal-diagnostic-handles.js";
import { projectWorkspacePackages } from "../../../core/internal/applicability.js";
import { camelize } from "../../../core/internal/component-facts.js";
import { loadVueCompilerSfc } from "../../../core/internal/lazy-parsers.js";
import {
  autoRegisteredNuxtLayers,
  readExportedNuxtOption,
} from "../../../core/internal/runtime-graph.js";
import {
  SFC_TEMPLATE_PARSE_OPTIONS,
  startTagEnd,
  TemplateNodeType,
  walkTemplate,
} from "../../../core/internal/template.js";
import {
  nuxtInventoryOwner,
  owningWorkspacePackage,
} from "../../../core/internal/workspace-packages.js";
import {
  type ComponentContract,
  type ComponentNames,
  componentFile,
  componentNames,
  componentTag,
  isUiKitFile,
  parseContractOptions,
  pascalCase,
  projectContracts,
} from "../contracts.js";
import { diagnostics } from "../diagnostics.js";

const RULE_ID = "design-system/prefer-project-component";
const TEXT_INPUT_TYPES = new Set(["text", "email", "password", "search", "url", "tel", "number"]);
const NUXT_UI: Record<string, string> = {
  button: "Button",
  input: "Input",
  textarea: "Textarea",
  select: "Select",
};
const INFERRED_NAMES = new Set(["Button", "Input", "Textarea", "Select", "Label"]);
const NUXT_CONFIG_SCRIPT_EXTENSIONS = ["js", "ts", "mjs", "cjs", "mts", "cts"];
const NUXT_CONFIG_DATA_EXTENSIONS = ["json", "jsonc", "json5", "yaml", "yml", "toml"];
const NUXT_LAYER_OPTIONS = ["extends", "_extends", "theme"];
const WORKSPACE_FILES = [
  "pnpm-workspace.yaml",
  "lerna.json",
  "turbo.json",
  "rush.json",
  "deno.json",
  "deno.jsonc",
];
const LOCKFILES = [
  "yarn.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "npm-shrinkwrap.json",
  "bun.lockb",
  "bun.lock",
  "deno.lock",
];
const PACKAGE_FILES = ["package.json", "package.json5", "package.yaml"];

/** A component that replaces a raw element, and how Doctor learned it. */
interface Candidate {
  component: string;
  source: "contract" | "config" | "nuxt-ui" | "inferred";
  confidence: Confidence;
  file?: string;
}

interface Options {
  contracts: Record<string, ComponentContract>;
}

export const preferProjectComponent = createRule({
  meta: {
    id: "design-system/prefer-project-component",
    title: "Use the project's component instead of a raw element",
    description:
      "Finds raw elements such as <button> where the project has a component that replaces them.",
    category: "ui",
    severity: "info",
    confidence: "heuristic-high",
    fixable: "suggestion",
    docsUrl: "https://vite-doctor.onmax.me/design-system#project-components",
    execution: "workspace",
    requires: { vue: true, crossFile: true },
    requiresContext: ["cross-file"],
    consumesEvidence: ["facts", "graph", "manifest"],
    cost: "small",
  },
  validateOptions: readOptions,
  create(ctx) {
    const options = readOptions(ctx.options);
    return {
      async onWorkspaceEnd() {
        const graph = await ctx.inventory.componentUsage();
        const scopes = componentScopes(ctx, graph);
        const templates = new Map<string, ParsedSfc | null>();
        const parsed = (file: string) => {
          if (!templates.has(file)) templates.set(file, parseSfc(ctx, file));
          return templates.get(file)!;
        };
        const declared = declaredCandidates(graph, options.contracts);
        const inferred = inferredCandidates(graph, parsed);
        const tags = new Set([...declared.keys(), ...inferred.keys(), ...Object.keys(NUXT_UI)]);
        const mentions = new RegExp(`<(?:${[...tags].join("|")})[\\s/>]`, "i");

        for (const node of graph.components.values()) {
          if (node.sourceKind === "module" || isUiKitFile(node.relativePath)) continue;
          if (!mentions.test(ctx.fs.readText(node.file) ?? "")) continue;
          const sfc = parsed(node.file);
          if (!sfc) continue;
          const scope = scopes(node);
          const bindings = localBindings(node);
          const replacements = new Map<string, Candidate | undefined>();
          const wrapper =
            !scope.isNuxtPage(node.file) &&
            (node.callers.length > 0 ||
              node.indirectImporters.length > 0 ||
              scope.registrations.has(node.file) ||
              /(?:^|\/)components\//.test(node.relativePath))
              ? sfc.root
              : undefined;
          walkTemplate(sfc.ast, (element) => {
            if (element.type !== TemplateNodeType.ELEMENT || element.tagType !== 0) return;
            const tag = element.tag.toLowerCase();
            if (!tags.has(tag) || element === wrapper || exempt(ctx, element)) return;
            if (!replacements.has(tag))
              replacements.set(
                tag,
                selectCandidate(
                  [declared.get(tag), scope.nuxtUi.get(tag), inferred.get(tag)],
                  node,
                  scope,
                  bindings,
                  graph,
                ),
              );
            const candidate = replacements.get(tag);
            if (!candidate) return;
            const start = element.loc.start.offset;
            const range = ctx.helpers.rangeFromOffsets(
              node.file,
              sfc.text,
              start,
              startTagEnd(element, sfc.text),
            );
            const copy = componentCopy(tag, candidate, ctx.project);
            ctx.report(diagnostics.DS0007(copy), {
              file: node.file,
              range,
              confidence: candidate.confidence,
              evidence: [
                {
                  kind:
                    candidate.source === "nuxt-ui" && candidate.confidence === "manifest-backed"
                      ? "manifest"
                      : candidate.source === "inferred"
                        ? "graph"
                        : "facts",
                  summary: evidenceSummary(tag, candidate, ctx.project),
                  ...(candidate.file && { file: candidate.file }),
                },
              ],
            });
          });
        }
      },
    };
  },
});

function readOptions(options: unknown): Options {
  if (options === undefined) return { contracts: {} };
  const invalid = (reason: string) =>
    doctorInternalDiagnostics.DOC0020({ ruleId: RULE_ID, reason });
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw invalid(
      'options must be an object such as { contracts: { UButton: { replaces: "button" } } }',
    );
  const { contracts, ...unknown } = options as Record<string, unknown>;
  const extra = Object.keys(unknown);
  if (extra.length) throw invalid(`unknown option ${extra.map((key) => `\`${key}\``).join(", ")}`);
  try {
    return { contracts: parseContractOptions(contracts) };
  } catch (error) {
    throw invalid((error as Error).message);
  }
}

interface ParsedSfc {
  text: string;
  ast: TemplateRootNode;
  /** The template's single unconditional root element, which renders as the component itself. */
  root?: TemplateElementNode;
}

function parseSfc(ctx: RuleContext, file: string): ParsedSfc | null {
  const text = ctx.fs.readText(file);
  if (text === undefined || !text.includes("<template")) return null;
  const ast = loadVueCompilerSfc().parse(text, { templateParseOptions: SFC_TEMPLATE_PARSE_OPTIONS })
    .descriptor.template?.ast as TemplateRootNode | undefined;
  if (!ast) return null;
  const roots = ast.children.filter(
    (child) =>
      child.type !== TemplateNodeType.COMMENT &&
      !(child.type === TemplateNodeType.TEXT && !child.content.trim()),
  );
  const only = roots.length === 1 ? roots[0] : undefined;
  const root =
    only?.type === TemplateNodeType.ELEMENT &&
    only.tagType === 0 &&
    !only.props.some(
      (prop) =>
        prop.type === TemplateNodeType.DIRECTIVE &&
        ["if", "else-if", "else", "for"].includes(prop.name),
    )
      ? only
      : undefined;
  return { text, ast, root };
}

/** Elements Doctor must not rewrite: opted out, or rendering something other than their tag. */
function exempt(ctx: RuleContext, element: TemplateElementNode): boolean {
  if (
    ctx.helpers.hasVueAttribute(element, "data-doctor-ignore") ||
    ctx.helpers.hasVueDirective(element, "bind", "data-doctor-ignore") ||
    ctx.helpers.hasVueDirective(element, "bind", "is") ||
    ctx.helpers.getStaticVueAttributeValue(element, "is")?.startsWith("vue:")
  )
    return true;
  // A button with no content is a hit area, such as a chart bar, not an action a styled button renders.
  if (element.tag.toLowerCase() === "button") return !hasContent(ctx, element);
  if (element.tag.toLowerCase() !== "input") return false;
  if (ctx.helpers.hasVueDirective(element, "bind", "type") || spreadAfterType(element)) return true;
  const type = ctx.helpers.getStaticVueAttributeValue(element, "type")?.toLowerCase() ?? "text";
  return !TEXT_INPUT_TYPES.has(type);
}

function hasContent(ctx: RuleContext, element: TemplateElementNode): boolean {
  return (
    element.props.some((prop) => {
      if (prop.type === TemplateNodeType.ATTRIBUTE)
        return isContentProperty(prop.name) && !!prop.value?.content;
      const expression = () => prop.exp && ctx.helpers.parseTemplateExpression(prop.exp);
      if (prop.name === "text" || prop.name === "html")
        return !isStaticallyEmptyContent(expression());
      if (prop.name !== "bind" || prop.modifiers.some(({ content }) => content === "attr"))
        return false;
      if (prop.arg) {
        return (
          prop.arg.isStatic &&
          isContentProperty(
            prop.modifiers.some(({ content }) => content === "camel")
              ? camelize(prop.arg.content)
              : prop.arg.content,
          ) &&
          !isStaticallyEmptyContent(expression())
        );
      }
      const binding = expression();
      return (
        binding?.type === "ObjectExpression" &&
        binding.properties.some(
          (entry) =>
            entry.type === "Property" &&
            !isStaticallyEmptyContent(entry.value) &&
            ((!entry.computed &&
              entry.key.type === "Identifier" &&
              isContentProperty(entry.key.name)) ||
              (entry.key.type === "Literal" &&
                typeof entry.key.value === "string" &&
                isContentProperty(entry.key.value))),
        )
      );
    }) ||
    element.children.some(
      (child) =>
        child.type !== TemplateNodeType.COMMENT &&
        !(child.type === TemplateNodeType.TEXT && !child.content.trim()),
    )
  );
}

function isStaticallyEmptyContent(value: ScriptAstNode | null | undefined): boolean {
  switch (value?.type) {
    case "Literal":
      return value.value === "" || value.value === null;
    case "TemplateLiteral":
      return value.expressions.length === 0 && value.quasis[0]?.value.cooked === "";
    case "UnaryExpression":
      return value.operator === "void";
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "TSTypeAssertion":
      return isStaticallyEmptyContent(value.expression);
    default:
      return false;
  }
}

function isContentProperty(name: string): boolean {
  return name === "textContent" || name === "innerHTML";
}

// An object v-bind can set or override type, so the rendered control is unknown statically.
function spreadAfterType(element: TemplateElementNode): boolean {
  let typeIndex = -1;
  element.props.forEach((prop, index) => {
    if (prop.type === TemplateNodeType.ATTRIBUTE && prop.name === "type") typeIndex = index;
  });
  return element.props.some(
    (prop, index) =>
      prop.type === TemplateNodeType.DIRECTIVE &&
      prop.name === "bind" &&
      !prop.arg &&
      index > typeIndex,
  );
}

function declaredCandidates(
  graph: ComponentUsageGraph,
  configContracts: Record<string, ComponentContract>,
): Map<string, Candidate[]> {
  const byTag = new Map<string, Candidate[]>();
  const names = { registered: new Map(), nuxtDefault: new Map() };
  for (const declared of projectContracts(graph, names).contracts)
    for (const tag of declared.contract.replaces)
      push(byTag, tag, {
        component: declared.component,
        source: "contract",
        confidence: "proven",
        ...(declared.file && { file: declared.file }),
      });
  for (const [component, contract] of Object.entries(configContracts))
    for (const tag of contract.replaces)
      push(byTag, tag, { component, source: "config", confidence: "proven" });
  return byTag;
}

interface ComponentScope {
  names: ComponentNames;
  files: ReadonlyMap<string, ComponentNode>;
  registrations: ReadonlySet<string>;
  nuxtUi: Map<string, Candidate[]>;
  isNuxtPage: (file: string) => boolean;
}

function componentScopes(ctx: RuleContext, graph: ComponentUsageGraph) {
  const project = ctx.project;
  const packages = projectWorkspacePackages(project);
  const owner = nuxtInventoryOwner(packages)?.root ?? ".";
  const packageFor = (node: ComponentNode) => owningWorkspacePackage(packages, node.relativePath);
  const filesByRoot = new Map<string, Map<string, ComponentNode>>();
  const scopes = new Map<string, ComponentScope>();
  for (const node of graph.components.values()) {
    const root = packageFor(node);
    const files = filesByRoot.get(root) ?? new Map();
    files.set(node.file, node);
    filesByRoot.set(root, files);
  }
  return (node: ComponentNode): ComponentScope => {
    const root = packageFor(node);
    const cached = scopes.get(root);
    if (cached) return cached;
    const pkg = packages.find((item) => item.root === root);
    const nuxt =
      project.workspaceNuxt?.find((entry) => entry.root === root)?.nuxt ??
      (root === owner ? project.nuxt : undefined);
    const appRoot = resolve(project.root, root);
    const files = filesByRoot.get(root) ?? new Map();
    const names = componentNames(
      { ...project, root: appRoot, nuxt, workspacePackages: pkg ? [pkg] : [] },
      { components: files, unresolved: [] },
    );
    const scope = {
      names,
      files,
      registrations: new Set([...names.registered.values(), ...names.nuxtDefault.values()]),
      isNuxtPage: nuxtPageMatcher(ctx, appRoot, nuxt),
      nuxtUi:
        (pkg && "@nuxt/ui" in pkg.packages) ||
        nuxt?.modules?.some((entry) => entry.name === "@nuxt/ui")
          ? nuxtUiCandidates(ctx, appRoot, nuxt)
          : new Map<string, Candidate[]>(),
    };
    scopes.set(root, scope);
    return scope;
  };
}

function localBindings(node: ComponentNode): Map<string, string | undefined> {
  return new Map<string, string | undefined>([
    ...node.facts.registeredComponentNames.map((name) => [name, undefined] as const),
    ...node.importedComponents,
  ]);
}

function localBindingName(tag: string, bindings: ReadonlyMap<string, string | undefined>) {
  return [tag, camelize(tag), pascalCase(tag)].find((name) => bindings.has(name));
}

function nuxtPageMatcher(ctx: RuleContext, appRoot: string, nuxt: NuxtProjectInfo | undefined) {
  if (!nuxt) return () => false;
  const manifest = nuxt.manifest;
  if (manifest?.resolvedAppCurrent?.pages && manifest.resolvedApp?.pagesResolved) {
    const pages = new Set(
      (manifest.pages ?? []).flatMap(({ file }) => (file ? [resolve(appRoot, file)] : [])),
    );
    return (file: string) => pages.has(file);
  }
  if (
    ctx.fs.exists(join(appRoot, ".nuxtignore")) ||
    appNuxtLayerNames(ctx, appRoot).length > 0 ||
    hasUnresolvedNuxtLayers(ctx, appRoot) ||
    ["ignore", "ignorePrefix", "hooks"].some(
      (key) => readNuxtOption(ctx, appRoot, key) !== undefined,
    )
  )
    return () => false;
  const patterns = nuxtPagePatterns(ctx, appRoot);
  if (patterns === null) return () => false;
  const srcDir = readLiteralNuxtOption(ctx, appRoot, "srcDir");
  const source = srcDir === undefined ? nuxt.appDir : srcDir;
  const pagesDir = readLiteralNuxtOption(ctx, appRoot, "dir", "pages");
  if (source == null || pagesDir === null) return () => false;
  const directory = resolve(appRoot, source, pagesDir ?? "pages");
  if (patterns !== undefined) {
    const isExclusion = (pattern: string) => pattern.startsWith("!") && !pattern.startsWith("!(");
    const exclude = patterns.filter(isExclusion).map((pattern) => pattern.slice(1));
    const include = patterns.filter((pattern) => !isExclusion(pattern));
    const pages = new Set(
      include.flatMap((pattern) => ctx.fs.glob(pattern, { cwd: directory, exclude })),
    );
    return (file: string) => pages.has(file);
  }
  return (file: string) => file.startsWith(`${directory}/`);
}

function nuxtPagePatterns(ctx: RuleContext, root: string): string[] | null | undefined {
  const pages = readNuxtOption(ctx, root, "pages");
  if (pages === undefined || (pages?.type === "Literal" && pages.value === true)) return undefined;
  if (pages?.type !== "ObjectExpression") return null;
  const enabled = readNuxtOption(ctx, root, "pages", "enabled");
  if (enabled !== undefined && (enabled?.type !== "Literal" || enabled.value !== true)) return null;
  const pattern = readNuxtOption(ctx, root, "pages", "pattern");
  if (pattern === undefined) return undefined;
  if (pattern?.type === "Literal" && typeof pattern.value === "string") return [pattern.value];
  if (pattern?.type !== "ArrayExpression") return null;
  const patterns: string[] = [];
  for (const element of pattern.elements) {
    if (element?.type !== "Literal" || typeof element.value !== "string") return null;
    patterns.push(element.value);
  }
  return patterns;
}

function selectCandidate(
  sources: (Candidate[] | undefined)[],
  node: ComponentNode,
  scope: ComponentScope,
  bindings: ReadonlyMap<string, string | undefined>,
  graph: ComponentUsageGraph,
): Candidate | undefined {
  const visible = (file: string) =>
    scope.files.has(file) || scope.registrations.has(file) || [...bindings.values()].includes(file);
  for (const source of sources) {
    const choices = new Map<string, Candidate>();
    for (const original of source ?? []) {
      let { file, component } = original;
      if (original.source === "config") {
        const binding = localBindingName(component, bindings);
        file = binding
          ? bindings.get(binding)
          : componentFile(component, scope.names, { components: scope.files, unresolved: [] });
      } else if (file && original.source !== "nuxt-ui") {
        if (!visible(file)) continue;
        const target = graph.components.get(file)!;
        component =
          [...bindings].find(([, value]) => value === file)?.[0] ??
          componentTag(target, scope.names);
      }
      const key = file ?? component;
      if (!choices.has(key)) choices.set(key, { ...original, component, file });
    }
    if (!choices.size) continue;
    if (choices.size !== 1) return undefined;
    const candidate = choices.values().next().value!;
    if (candidate.file === node.file) return undefined;
    const binding = localBindingName(candidate.component, bindings);
    if (binding) {
      if (bindings.get(binding) !== candidate.file) return undefined;
      if (!candidate.file && candidate.source !== "config") return undefined;
    } else {
      const name = pascalCase(candidate.component);
      const registered = scope.names.registered.get(name) ?? scope.names.nuxtDefault.get(name);
      if (registered && registered !== candidate.file) return undefined;
    }
    return candidate;
  }
}

function nuxtUiCandidates(
  ctx: RuleContext,
  appRoot: string,
  nuxt: NuxtProjectInfo | undefined,
): Map<string, Candidate[]> {
  const byTag = new Map<string, Candidate[]>();
  const resolved = nuxt?.manifest?.resolvedComponents;
  const registered = resolved ?? [...(nuxt?.components.values() ?? [])];
  const prefix = resolved ? undefined : nuxtUiPrefix(ctx, appRoot);
  for (const [tag, implementation] of Object.entries(NUXT_UI)) {
    const matches = registered.filter(
      ({ file }) =>
        file
          .replaceAll("\\", "/")
          .endsWith(`/node_modules/@nuxt/ui/dist/runtime/components/${implementation}.vue`) ||
        file.replaceAll("\\", "/") ===
          `node_modules/@nuxt/ui/dist/runtime/components/${implementation}.vue`,
    );
    for (const entry of matches) {
      if (
        entry.mode === "server" ||
        registered.some((other) => other.name === entry.name && other.file !== entry.file)
      )
        continue;
      push(byTag, tag, {
        component: entry.name,
        file: resolve(appRoot, entry.file),
        source: "nuxt-ui",
        confidence: resolved ? "manifest-backed" : "heuristic-high",
      });
    }
    if (resolved || matches.length || prefix === undefined) continue;
    const component = `${prefix}${implementation}`;
    if (registered.some((entry) => entry.name === component)) continue;
    push(byTag, tag, { component, source: "nuxt-ui", confidence: "heuristic-high" });
  }
  return byTag;
}

function nuxtUiPrefix(ctx: RuleContext, appRoot: string) {
  const appPrefix = readLiteralNuxtOption(ctx, appRoot, "ui", "prefix");
  if (appPrefix !== undefined) return appPrefix ?? undefined;
  if (hasUnresolvedNuxtLayers(ctx, appRoot)) return undefined;
  let prefix: string | undefined;
  for (const name of appNuxtLayerNames(ctx, appRoot)) {
    const root = join(appRoot, "layers", name);
    if (NUXT_LAYER_OPTIONS.some((key) => readMainNuxtOption(ctx, root, key) !== undefined))
      return undefined;
    const layerPrefix = literalNuxtString(readMainNuxtOption(ctx, root, "ui", "prefix"));
    if (layerPrefix === undefined) continue;
    if (layerPrefix === null || (prefix !== undefined && layerPrefix !== prefix)) return undefined;
    prefix = layerPrefix;
  }
  return prefix ?? "U";
}

function appNuxtLayerNames(ctx: RuleContext, appRoot: string) {
  return autoRegisteredNuxtLayers(appRoot, ctx.fs).filter((name) => !name.startsWith("."));
}

function hasUnresolvedNuxtLayers(ctx: RuleContext, root: string) {
  return NUXT_LAYER_OPTIONS.some((key) => readNuxtOption(ctx, root, key) !== undefined);
}

function readLiteralNuxtOption(ctx: RuleContext, root: string, key: string, nested?: string) {
  return literalNuxtString(readNuxtOption(ctx, root, key, nested));
}

function literalNuxtString(option: ReturnType<typeof readMainNuxtOption>) {
  if (option === undefined) return undefined;
  return option?.type === "Literal" && typeof option.value === "string" ? option.value : null;
}

function readNuxtOption(ctx: RuleContext, root: string, key: string, nested?: string) {
  const main = readMainNuxtOption(ctx, root, key, nested);
  if (main === null || (main?.type === "Literal" && typeof main.value === "string")) return main;
  if (nuxtRcMaySetOption(ctx, root, key, nested)) return null;
  const workspace = nuxtRcWorkspaceRoot(ctx.fs, root);
  if (workspace && workspace !== root && nuxtRcMaySetOption(ctx, workspace, key, nested))
    return null;
  return main;
}

function nuxtRcWorkspaceRoot(fs: RuleFileSystem, appRoot: string): string | undefined {
  const contains = (root: string, names: string[]) =>
    names.some((name) => fs.stat(join(root, name))?.isFile());
  let workspace: string | undefined;
  let git: string | undefined;
  let lockfile: string | undefined;
  let pkg: string | undefined;
  for (let root = appRoot; root !== dirname(root); root = dirname(root)) {
    if (contains(root, WORKSPACE_FILES)) workspace = root;
    if (!git && fs.stat(join(root, ".git/config"))?.isFile()) git = root;
    if (contains(root, LOCKFILES)) lockfile = root;
    if (contains(root, PACKAGE_FILES)) pkg = root;
    if (root.endsWith("/node_modules")) break;
  }
  return workspace ?? git ?? lockfile ?? pkg;
}

function nuxtRcMaySetOption(ctx: RuleContext, root: string, key: string, nested?: string) {
  const file = join(root, ".nuxtrc");
  const text = ctx.fs.readText(file);
  if (text === undefined) return ctx.fs.exists(file);
  const path = nested ? `${key}.${nested}` : key;
  return text.split(/[\r\n]/).some((line) => {
    const assignment = /^\s*([^\s=]+)\s*=/.exec(line)?.[1];
    if (!assignment) return false;
    const rcPath = assignment.replace(/\[\]$/, "");
    return rcPath === key || rcPath === path || rcPath.startsWith(`${path}.`);
  });
}

function readMainNuxtOption(ctx: RuleContext, root: string, key: string, nested?: string) {
  for (const ext of NUXT_CONFIG_SCRIPT_EXTENSIONS) {
    const file = join(root, `nuxt.config.${ext}`);
    const text = ctx.fs.readText(file);
    if (text === undefined) {
      if (ctx.fs.exists(file)) return null;
      continue;
    }
    return readExportedNuxtOption(file, text, key, nested);
  }
  if (
    NUXT_CONFIG_DATA_EXTENSIONS.some((ext) => ctx.fs.exists(join(root, `nuxt.config.${ext}`))) ||
    ctx.fs
      .readDir(join(root, ".config"))
      ?.some(({ name }) => /^nuxt(?:\.config)?(?:\.|$)/.test(name))
  )
    return null;
}

/**
 * SFCs named exactly after the element they wrap, such as shadcn-vue's
 * `components/ui/button/Button.vue`, or a `Button.vue` whose only root is a `<button>`.
 */
function inferredCandidates(
  graph: ComponentUsageGraph,
  parsed: (file: string) => ParsedSfc | null,
): Map<string, Candidate[]> {
  const byTag = new Map<string, Candidate[]>();
  for (const node of graph.components.values()) {
    if (node.sourceKind === "module") continue;
    const base = node.relativePath
      .split("/")
      .pop()!
      .replace(/\.vue$/, "");
    if (!INFERRED_NAMES.has(base)) continue;
    const tag = base.toLowerCase();
    if (!isUiKitFile(node.relativePath) && parsed(node.file)?.root?.tag.toLowerCase() !== tag)
      continue;
    push(byTag, tag, {
      component: base,
      source: "inferred",
      confidence: "heuristic-high",
      file: node.file,
    });
  }
  return byTag;
}

function push(byTag: Map<string, Candidate[]>, tag: string, candidate: Candidate) {
  const list = byTag.get(tag) ?? [];
  if (
    !list.some((entry) => entry.file === candidate.file && entry.component === candidate.component)
  )
    list.push(candidate);
  byTag.set(tag, list);
}

function evidenceSummary(tag: string, candidate: Candidate, project: ProjectInfo): string {
  const { component } = candidate;
  const where = candidate.file ? ` (${relative(project.root, candidate.file)})` : "";
  switch (candidate.source) {
    case "contract":
      return `${component}${where} declares defineOptions({ doctor: { replaces: "${tag}" } }).`;
    case "config":
      return `The Rule's contracts option declares that ${component} replaces <${tag}>.`;
    case "nuxt-ui":
      return candidate.confidence === "manifest-backed"
        ? `The Nuxt manifest registers ${component} from @nuxt/ui.`
        : `The project depends on @nuxt/ui, which provides ${component}.`;
    case "inferred":
      return `${component}${where} is named after <${tag}> and is the only component that wraps it.`;
  }
}

const LOSSES: Record<string, string> = {
  button: "its focus ring, size, and disabled or loading states can differ from every other button",
  input: "its height, focus ring, and invalid state can differ from every other field",
  textarea: "its padding, focus ring, and invalid state can differ from every other field",
  select: "its trigger, focus ring, and option list can differ from every other select",
};

function componentCopy(
  tag: string,
  candidate: Candidate,
  project: ProjectInfo,
): { why: string; fix: string } {
  const { component } = candidate;
  const nuxtUi = candidate.source === "nuxt-ui";
  const prefix =
    nuxtUi && component.endsWith(NUXT_UI[tag]!)
      ? component.slice(0, -NUXT_UI[tag]!.length)
      : undefined;
  const formFieldName = prefix === undefined ? "the form field component" : `${prefix}FormField`;
  const source = {
    contract: `${component} declares that it replaces <${tag}>`,
    config: `the project's Doctor config declares that ${component} replaces <${tag}>`,
    "nuxt-ui": `the app uses Nuxt UI, whose ${component} replaces <${tag}>`,
    inferred: `${component}${candidate.file ? ` in ${relative(project.root, candidate.file)}` : ""} is the project's <${tag}> component`,
  }[candidate.source];
  const formField =
    nuxtUi && tag !== "button"
      ? `, and it misses the label, help text, and error wiring ${formFieldName} gives Nuxt UI controls`
      : "";
  const why = `This raw <${tag}> bypasses ${component}: ${source}. Users see a control that does not match the rest of the app: ${LOSSES[tag] ?? "its styling and states can differ from the project's other instances"}${formField}.`;
  const fieldAdvice =
    prefix === undefined
      ? " Wrap it in the form field component to get its label and validation error."
      : ` Wrap it in <${prefix}FormField> to get its label and validation error.`;
  const props = nuxtUi
    ? {
        button: ` Move styling classes to ${component} props: color, variant, size, and icon.`,
        input: fieldAdvice,
        textarea: fieldAdvice,
        select: ` Turn the <option> elements into its \`items\` prop.${prefix === undefined ? "" : ` Use <${prefix}SelectMenu> for searchable or rich options.`}`,
      }[tag]
    : ` Move styling classes to ${component}'s props, and drop classes it already applies.`;
  const fix = `Replace <${tag}> with <${component}>, keeping its attributes, v-model, listeners, and content.${props ?? ""}`;
  return { why, fix };
}
