import { dirname, isAbsolute, relative, resolve } from "pathe";
import {
  createRule,
  type NuxtProjectInfo,
  type RuleContext,
  type SourceRange,
} from "../../../../core/index.js";
import {
  analyzeScript,
  scopeDialect,
  type ScriptScope,
  type ScopeReference,
  type ScopeVariable,
} from "../../../../core/internal/script-scope.js";
import { parseSfcFile } from "../../../../core/internal/sfc.js";
import { workspaceViewRoot } from "../../../../core/internal/workspace-nuxt.js";
import { diagnostics } from "../../diagnostics.js";
import { scriptNodesOfType } from "../../../../core/internal/script-index.js";
import type { AnyNode } from "./shared.js";

const RULE_ID = "nuxt/state/no-diverging-usestate-init";
const NUXT_SOURCE_RE = /^(?:#app|nuxt\/app|nuxt)$/;
const STATE_SOURCE_RE = /(?:^#app\/|(?:^|\/)nuxt\/dist\/app\/)composables\/state(?:\.[cm]?[jt]s)?$/;
const SCRIPT_RE = /\.(?:[cm]?[jt]s|[jt]sx|vue)$/;
const SNIPPET_LENGTH = 80;

interface StateInit {
  key: string;
  file: string;
  displayPath: string;
  range: SourceRange;
  source: string;
  normalized: string;
}

export const noDivergingUseStateInit = createRule({
  meta: {
    id: RULE_ID,
    title: "Initialize each useState key in one place",
    category: "state",
    severity: "warn",
    confidence: "heuristic-medium",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/api/composables/use-state#usage",
    execution: "workspace",
    cacheScope: "none",
    requires: { nuxt: true, crossFile: true },
    requiresContext: ["cross-file"],
    consumesEvidence: ["ast"],
    cost: "medium",
  },
  create(ctx) {
    return {
      async onWorkspaceEnd() {
        const groups = new Map<string, StateInit[]>();
        for (const init of await collectStateInits(ctx)) {
          const group = groups.get(init.key);
          if (group) group.push(init);
          else groups.set(init.key, [init]);
        }
        for (const [key, inits] of groups) {
          if (new Set(inits.map((init) => init.normalized)).size < 2) continue;
          reportKey(ctx, key, inits);
        }
      },
    };
  },
});

function reportKey(ctx: RuleContext, key: string, inits: StateInit[]) {
  const [primary, ...others] = inits;
  if (!primary) return;
  const quoted = /^[\w-]+$/.test(key) ? `'${key}'` : JSON.stringify(key);
  const location = (init: StateInit) =>
    `${init.displayPath}:${init.range.line}:${init.range.column}`;
  const variants = [...new Map(inits.map((init) => [init.normalized, init])).values()];
  ctx.report(
    diagnostics.NUXT0097({
      why: `useState(${quoted}) is initialized with ${variants.length} different initializers: ${variants.map((init) => `${snippet(init.source)} at ${location(init)}`).join(", ")}. useState() only runs an initializer while key ${quoted} has no value. Once one initializer sets the value, the others are ignored, so route and render order can change the starting value.`,
      fix: `Initialize ${quoted} in one composable and call it from every site that uses that state. If the sites mean different state, give each its own key instead. Do not copy one initializer into every site or suppress this Diagnostic: each site would still decide the starting value, and the next edit to one of them brings the divergence back.`,
      sources: inits.map(location),
    }),
    {
      ruleId: RULE_ID,
      severity: ctx.severity,
      category: "state",
      file: primary.file,
      range: primary.range,
      confidence: "heuristic-medium",
      related: others.map((other) => ({
        file: other.file,
        range: other.range,
        message: `Also initializes useState(${quoted}) with ${snippet(other.source)}`,
      })),
      evidence: inits.map((init) => ({
        kind: "ast" as const,
        file: init.file,
        range: init.range,
        summary: `useState(${quoted}, ${snippet(init.source)})`,
      })),
    },
  );
}

async function collectStateInits(ctx: RuleContext): Promise<StateInit[]> {
  const { project } = ctx;
  const nuxt = project.nuxt;
  if (!nuxt) return [];
  const appRoot = resolve(
    project.root,
    workspaceViewRoot(project) ??
      (nuxt.manifestPath ? dirname(dirname(nuxt.manifestPath)) : (nuxt.layers[0]?.root ?? ".")),
  );
  const layerRoots = nuxt.layers.map((layer) => resolve(appRoot, layer.root));
  const appRoots = [appRoot, ...layerRoots, ...(nuxt.manifest?.appScanRoots ?? [])].sort(
    (left, right) => right.length - left.length,
  );
  const otherRoots = (project.workspaceNuxt ?? [])
    .map(({ root }) => resolve(project.root, root))
    .filter((root) => root !== appRoot && !layerRoots.includes(root));
  const inits: StateInit[] = [];
  for (const file of await ctx.inventory.sourcePaths()) {
    if (!SCRIPT_RE.test(file) || /\.d\.[cm]?ts$/.test(file)) continue;
    const root = appRoots.find((root) => isInside(root, file));
    if (!root || otherRoots.some((other) => isInside(root, other) && isInside(other, file)))
      continue;
    if ([...layerRoots, appRoot].some((root) => ctx.helpers.isNuxtServerFile(relative(root, file))))
      continue;
    const text = ctx.fs.readText(file);
    if (!text) continue;
    for (const { scope, offset, outerBindings } of await stateScripts(file, text)) {
      if (!scope) continue;
      for (const call of scriptNodesOfType(scope.ast, "CallExpression")) {
        if (
          call.callee?.type !== "Identifier" ||
          !isNuxtUseState(scope.references.get(call.callee), nuxt, outerBindings)
        )
          continue;
        const [keyNode, init] = call.arguments ?? [];
        const key = literalKey(keyNode);
        if (key === undefined || !init || init.type === "SpreadElement") continue;
        if (init.type === "Identifier" && init.name === "undefined") continue;
        inits.push({
          key,
          file,
          displayPath: relative(project.root, file),
          range: ctx.helpers.rangeFromOffsets(file, text, offset + call.start, offset + call.end),
          source: text.slice(offset + init.start, offset + init.end),
          normalized: initializerShape(init),
        });
      }
    }
  }
  // Script files first: a composable is the likelier home for the state than a component.
  return inits.sort(
    (a, b) =>
      Number(a.file.endsWith(".vue")) - Number(b.file.endsWith(".vue")) ||
      a.displayPath.localeCompare(b.displayPath) ||
      a.range.line - b.range.line ||
      a.range.column - b.range.column,
  );
}

interface StateScript {
  scope: ScriptScope | null;
  offset: number;
  outerBindings?: ReadonlyMap<string, ScopeVariable>;
}

async function stateScripts(file: string, text: string): Promise<StateScript[]> {
  if (!file.endsWith(".vue"))
    return [{ scope: analyzeScript(text, scopeDialect(file)), offset: 0 }];

  const {
    descriptor: { script, scriptSetup },
  } = await parseSfcFile(file, text);
  const parseBlock = (block: NonNullable<typeof script>) => ({
    scope: analyzeScript(
      block.content,
      scopeDialect(file, block.lang === "tsx" || block.lang === "jsx"),
    ),
    offset: block.loc.start.offset,
  });
  const module = script && parseBlock(script);
  const setup = scriptSetup && parseBlock(scriptSetup);
  if (!module || !setup) return module ? [module] : setup ? [setup] : [];

  const moduleBindings = topLevelBindings(module.scope);
  const setupImports = new Map(
    [...(topLevelBindings(setup.scope) ?? [])].filter(([, binding]) =>
      binding.defs.some((definition) => definition.type === "ImportBinding"),
    ),
  );
  return [
    { ...module, outerBindings: setupImports },
    { ...setup, outerBindings: moduleBindings },
  ];
}

function topLevelBindings(scope: ScriptScope | null) {
  return scope?.scopeManager.scopes.find((scope) => scope.type === "module")?.set;
}

function isInside(root: string, file: string): boolean {
  const path = relative(root, file);
  return path !== ".." && !path.startsWith("../") && !isAbsolute(path);
}

function isNuxtUseState(
  reference: ScopeReference | undefined,
  nuxt: NuxtProjectInfo,
  outerBindings: StateScript["outerBindings"],
): boolean {
  if (!reference) return false;
  const name = reference.identifier.name;
  const outer = outerBindings?.get(name);
  const binding = reference.resolved ?? (outer?.isValueVariable ? outer : undefined);
  if (!binding) return nuxt.autoImportEnabled && isNuxtAutoImport(name, nuxt);
  return binding.defs.some((definition) => {
    if (definition.type !== "ImportBinding") return false;
    const { node, parent } = definition;
    if (
      node.type !== "ImportSpecifier" ||
      node.importKind === "type" ||
      parent.type !== "ImportDeclaration" ||
      parent.importKind === "type"
    )
      return false;
    const name = node.imported.type === "Identifier" ? node.imported.name : node.imported.value;
    const source = parent.source.value;
    return source === "#imports"
      ? isNuxtAutoImport(name, nuxt)
      : name === "useState" && (NUXT_SOURCE_RE.test(source) || STATE_SOURCE_RE.test(source));
  });
}

function isNuxtAutoImport(name: string, nuxt: NuxtProjectInfo): boolean {
  const entry = nuxt.autoImports.get(name);
  if (!entry) return name === "useState" && !nuxt.autoImportsAuthoritative;
  return (
    entry.name === "useState" &&
    !entry.type &&
    (NUXT_SOURCE_RE.test(entry.from) ||
      STATE_SOURCE_RE.test(entry.from) ||
      (entry.from === "#imports" && entry.kind === "nuxt"))
  );
}

function literalKey(node: AnyNode): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? undefined;
}

function initializerShape(node: AnyNode): string {
  return JSON.stringify(node, function (key, value: unknown) {
    if (key === "start" || key === "end" || key === "range" || key === "loc") return undefined;
    if (key === "raw" && this.type === "Literal") return undefined;
    if (typeof value === "number" && !Number.isFinite(value)) return { number: String(value) };
    return typeof value === "bigint" ? value.toString() : value;
  });
}

function snippet(source: string): string {
  return source.length > SNIPPET_LENGTH ? `${source.slice(0, SNIPPET_LENGTH - 1)}…` : source;
}
