import { createRule, type RuleContext, type SourceRange } from "../../../../core/index.js";
import { parseScript } from "../../../../core/internal/script.js";
import { parseSfcFile, parseVueScripts } from "../../../../core/internal/sfc.js";
// oxlint-disable-next-line no-restricted-imports -- walks the project tree, so the Rule declares cacheScope "none".
import { selectScanFiles } from "../../../../core/internal/source-inventory.js";
import { diagnostics } from "../../diagnostics.js";
import { scriptNodesOfType } from "./script-index.js";
import type { AnyNode } from "./shared.js";

const RULE_ID = "nuxt/state/no-diverging-usestate-init";
const NUXT_SOURCE_RE = /^(?:#imports|#app(?:\/.*)?|nuxt\/app|nuxt)$/;
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
        for (const init of await collectStateInits(ctx))
          groups.set(init.key, [...(groups.get(init.key) ?? []), init]);
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
  const quoted = `'${key}'`;
  const location = (init: StateInit) =>
    `${init.displayPath}:${init.range.line}:${init.range.column}`;
  const variants = [...new Map(inits.map((init) => [init.normalized, init])).values()];
  ctx.report(
    diagnostics.NUXT0097({
      why: `useState(${quoted}) is initialized with ${variants.length} different initializers: ${variants.map((init) => `${snippet(init.source)} at ${location(init)}`).join(", ")}. useState() runs its initializer only while key ${quoted} has no value, so whichever call site runs first decides the starting value, and every other initializer is silently ignored. Which one runs first depends on the route and render order, and clearNuxtState(${quoted}, { reset: true }) resets to the first initializer registered.`,
      fix: `Initialize ${quoted} in one composable, such as export const ${composableName(key)} = () => useState(${quoted}, ${snippet(primary.source)}), and call it at every site instead of useState(${quoted}, ...). Don't just align the initializers in place: if the call sites mean different state, give each its own key.`,
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
  const entries = await selectScanFiles(ctx.project.root, {}, {}, ctx.project);
  const inits: StateInit[] = [];
  for (const entry of entries) {
    if (entry.sourceKind === "module" || !SCRIPT_RE.test(entry.path)) continue;
    if (/\.d\.[cm]?ts$/.test(entry.path) || ctx.helpers.isNuxtServerFile(entry.displayPath))
      continue;
    const text = ctx.fs.readText(entry.path);
    if (!text?.includes("useState")) continue;
    const program = entry.path.endsWith(".vue")
      ? parseVueScripts(entry.path, (await parseSfcFile(entry.path, text)).descriptor, text)
      : parseScript(entry.path, text);
    if (!program) continue;
    const callees = useStateNames(program);
    for (const call of scriptNodesOfType(program, "CallExpression")) {
      if (call.callee?.type !== "Identifier" || !callees.has(call.callee.name)) continue;
      const [keyNode, init] = call.arguments ?? [];
      const key = literalKey(keyNode);
      if (key === undefined || !init || init.type === "SpreadElement") continue;
      if (init.type === "Identifier" && init.name === "undefined") continue;
      const source = text.slice(init.start, init.end);
      inits.push({
        key,
        file: entry.path,
        displayPath: entry.displayPath,
        range: ctx.helpers.rangeFromOffsets(entry.path, text, call.start, call.end),
        source,
        normalized: normalize(source),
      });
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

/** Local names that call Nuxt's useState: the auto-import unless shadowed, plus aliased imports. */
function useStateNames(program: AnyNode): Set<string> {
  const names = new Set(["useState"]);
  for (const statement of program.body ?? []) {
    if (statement.type === "ImportDeclaration") {
      const nuxt = NUXT_SOURCE_RE.test(statement.source?.value);
      for (const specifier of statement.specifiers ?? []) {
        const imported = specifier.imported?.name ?? specifier.imported?.value;
        if (nuxt && specifier.type === "ImportSpecifier" && imported === "useState")
          names.add(specifier.local.name);
        else if (specifier.local?.name === "useState") names.delete("useState");
      }
      continue;
    }
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "FunctionDeclaration" && declaration.id?.name === "useState")
      names.delete("useState");
    if (declaration?.type === "VariableDeclaration")
      for (const declarator of declaration.declarations ?? [])
        if (declarator.id?.type === "Identifier" && declarator.id.name === "useState")
          names.delete("useState");
  }
  return names;
}

function literalKey(node: AnyNode): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? undefined;
}

function normalize(source: string): string {
  return source.replace(/\s+/g, " ").replace(/ (?=\W)|(?<=\W) /g, "");
}

function composableName(key: string): string {
  const words = key.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const name = words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join("");
  return /^[A-Z]/.test(name) ? `use${name}` : "useSharedState";
}

function snippet(source: string): string {
  const flat = source.replace(/\s+/g, " ");
  return flat.length > SNIPPET_LENGTH ? `${flat.slice(0, SNIPPET_LENGTH - 1)}…` : flat;
}
