import type { Node, Program } from "oxc-parser";
import { relative, resolve } from "pathe";
import { createRule, type ImportGraphEdge, type RuleContext } from "../../../core/index.js";
import { walkAstFacts } from "../../../core/internal/facts.js";
import { computeSccs } from "../../../core/internal/import-graph.js";
import { parseScriptResult, parseScriptSync } from "../../../core/internal/script.js";
import { sha256 } from "../../../core/internal/utils.js";
import { findViteConfigFile } from "../../../core/internal/vite-config-file.js";
import { diagnostics } from "../../../diagnostics.js";
import { memberPath, propertyName, type AnyNode } from "./shared.js";

const RULE_ID = "vite/hmr/no-circular-import-at-hmr-boundary";

export const noCircularImportAtHmrBoundary = createRule({
  meta: {
    id: RULE_ID,
    title: "Keep HMR boundaries out of import cycles",
    category: "hmr",
    severity: "info",
    confidence: "heuristic-high",
    docsUrl: "https://vite.dev/guide/troubleshooting#a-full-reload-happens-instead-of-hmr",
    execution: "workspace",
    requires: { crossFile: true },
    requiresContext: ["cross-file"],
    consumesEvidence: ["graph"],
    cost: "small",
  },
  create(ctx) {
    return {
      async onWorkspaceEnd() {
        const graph = await ctx.inventory.importGraph();
        const path = (file: string) => relative(ctx.project.root, file);
        const vueHmr = clientHmrSetting(ctx);
        // Vite's importer graph, which HMR propagation walks: every resolved import, re-export
        // and literal import() that survives TypeScript's type erasure.
        const successors = new Map<string, ImportGraphEdge[]>();
        for (const edge of graph.edges) {
          if (!edge.to || edge.to === edge.from || edge.typeOnly) continue;
          const list = successors.get(edge.from);
          if (list) list.push(edge);
          else successors.set(edge.from, [edge]);
        }
        const groups = computeSccs(graph.files, (file) =>
          (successors.get(file) ?? []).map((edge) => edge.to!),
        )
          .filter((group) => group.length > 1)
          .map((group) => [...group].sort())
          .sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
        for (const files of groups) {
          const boundaries = new Set(
            files.filter((file) =>
              file.endsWith(".vue") ? !vueHmr.disabled : isSelfAcceptingModule(file, ctx),
            ),
          );
          if (!boundaries.size) continue;
          const loop = loopThroughBoundary(files, boundaries, successors);
          if (!loop) continue;
          const [edge, back] = [loop[0]!, loop[1]!];
          const boundary = edge.to!;
          const steps = [...loop.map((item) => path(item.from)), path(edge.from)].join(" → ");
          const kind = boundary.endsWith(".vue")
            ? "a Vue SFC, which @vitejs/plugin-vue makes accept its own updates in dev"
            : "a module that calls import.meta.hot.accept() for its own updates";
          const backAt = back.range ? `${path(back.from)}:${back.range.line}` : path(back.from);
          ctx.report(
            diagnostics.VITE0029({
              why: `Circular import through the HMR boundary ${path(boundary)}: ${steps}. ${path(boundary)} is ${kind}. When an edit inside this cycle reaches it, Vite marks the update as within a circular import, and the browser re-imports ${path(boundary)}, which can re-run modules of the cycle. If that re-import throws, for example because a module reads a binding of the cycle before it is initialized, Vite reloads the whole page instead of applying the update.`,
              fix: `Remove the import that leads from ${path(boundary)} back into the cycle: ${backAt} imports '${back.specifier}'. Move what ${path(boundary)} needs from ${path(back.to!)} into a module that imports neither, or read it at runtime instead of importing it, such as useRouter() in a component instead of the router module. Loading ${path(boundary)} lazily with import() does not help: Vite records dynamic imports as importers for HMR, so the loop stays. Do not decline HMR with import.meta.hot.decline() or suppress this Diagnostic to hide the cycle.`,
              sources: edge.range
                ? [`${edge.from}:${edge.range.line}:${edge.range.column}`]
                : undefined,
            }),
            {
              file: edge.from,
              range: edge.range,
              related: loop.map((item) => ({
                file: item.from,
                ...(item.range ? { range: item.range } : {}),
                message: `${EDGE_VERB[item.kind]} '${item.specifier}' → ${path(item.to!)}`,
              })),
              // Keyed on the group rather than the loop, so reordering imports keeps baselined findings.
              fingerprint: sha256(`${RULE_ID}:${files.map(path).join("\n")}`),
              evidence: [
                {
                  kind: "graph",
                  file: boundary,
                  summary: `${
                    boundary.endsWith(".vue")
                      ? `${path(boundary)} is a Vue SFC. ${vueHmr.note}`
                      : `${path(boundary)} calls import.meta.hot.accept() without a dependency.`
                  } It is in a group of ${files.length} files joined by Vite's HMR importer edges: static imports, re-exports, and import() calls with a literal path.`,
                },
              ],
            },
          );
        }
      },
    };
  },
});

const EDGE_VERB: Record<ImportGraphEdge["kind"], string> = {
  import: "imports",
  "re-export": "re-exports",
  "dynamic-import": "lazily imports",
};

/**
 * Whether the module calls `import.meta.hot.accept()` or `accept(cb)`, which Vite's import analysis
 * marks as self-accepting. `accept('./dep', cb)` accepts the dependency instead, and
 * `acceptExports` accepts only some exports; both are left out until Doctor can tie them to the cycle.
 */
function isSelfAcceptingModule(file: string, ctx: RuleContext): boolean {
  if (!/\.[cm]?[jt]sx?$/.test(file)) return false;
  const text = ctx.fs.readText(file);
  if (!text?.includes("import.meta.hot")) return false;
  const { ast } = parseScriptResult(file, text);
  let found = false;
  walkAstFacts(ast, (node) => {
    const call = node as AnyNode;
    if (found || call.type !== "CallExpression") return;
    if (memberPath(call.callee) !== "import.meta.hot.accept") return;
    const first = call.arguments?.[0];
    found =
      !first ||
      !["Literal", "TemplateLiteral", "ArrayExpression"].includes(first.type) ||
      (first.type === "Literal" && typeof first.value !== "string");
  });
  return found;
}

function clientHmrSetting(ctx: RuleContext): { disabled: boolean; note: string } {
  const { root } = ctx.project;
  const vite = ctx.project.runtimeEvidence?.vite as
    | { clientHmr?: { root?: unknown; enabled?: unknown } }
    | undefined;
  const resolved = vite?.clientHmr;
  if (
    typeof resolved?.root === "string" &&
    resolve(resolved.root) === resolve(root) &&
    typeof resolved.enabled === "boolean"
  ) {
    return {
      disabled: !resolved.enabled,
      note: `Resolved Vite dev config has client HMR ${resolved.enabled ? "enabled" : "disabled"}.`,
    };
  }
  const file =
    ctx.project.framework === "nuxt" || ctx.project.nuxt
      ? undefined
      : findViteConfigFile(root, (path) => ctx.fs.exists(path));
  const text = file && ctx.fs.readText(file);
  if (file && text) {
    const { program, errors } = parseScriptSync(file, text, {
      astType: "ts",
      preserveParens: false,
    });
    if (!errors.some((error) => error.severity === "Error") && staticallyDisablesHmr(program)) {
      return {
        disabled: true,
        note: `${relative(root, file)} exports server.hmr: false.`,
      };
    }
  }
  return {
    disabled: false,
    note: "Doctor did not resolve the dev server.hmr setting, so it assumes client HMR is on, as @vitejs/plugin-vue does by default in dev.",
  };
}

function staticallyDisablesHmr(program: Program): boolean {
  const exported = program.body.find((node) => node.type === "ExportDefaultDeclaration");
  let config: Node | undefined = unwrapConfigExpression(exported?.declaration);
  if (config?.type === "CallExpression" && !config.optional && config.arguments.length === 1) {
    const { callee } = config;
    if (
      callee.type === "Identifier" &&
      program.body.some(
        (node) =>
          node.type === "ImportDeclaration" &&
          node.source.value === "vite" &&
          node.importKind !== "type" &&
          node.specifiers.some(
            (specifier) =>
              specifier.type === "ImportSpecifier" &&
              specifier.importKind !== "type" &&
              propertyName(specifier.imported) === "defineConfig" &&
              specifier.local.name === callee.name,
          ),
      )
    ) {
      config = unwrapConfigExpression(config.arguments[0]);
    }
  }
  const hmr = staticProperty(staticProperty(config, "server"), "hmr");
  return hmr?.type === "Literal" && hmr.value === false;
}

function unwrapConfigExpression(node: Node | undefined): Node | undefined {
  while (
    node?.type === "TSAsExpression" ||
    node?.type === "TSSatisfiesExpression" ||
    node?.type === "TSTypeAssertion" ||
    node?.type === "TSNonNullExpression"
  ) {
    node = node.expression;
  }
  return node;
}

function staticProperty(node: Node | undefined, name: string): Node | undefined {
  if (node?.type !== "ObjectExpression") return undefined;
  for (let index = node.properties.length - 1; index >= 0; index--) {
    const property = node.properties[index]!;
    if (property.type !== "Property" || property.computed) return undefined;
    if (propertyName(property.key) === name) {
      return property.kind === "init" && !property.method && !property.shorthand
        ? unwrapConfigExpression(property.value)
        : undefined;
    }
  }
}

/** A shortest loop of the group that enters an HMR boundary, rotated to start at the edge into it. */
function loopThroughBoundary(
  files: readonly string[],
  boundaries: ReadonlySet<string>,
  successors: ReadonlyMap<string, ImportGraphEdge[]>,
): ImportGraphEdge[] | undefined {
  const group = new Set(files);
  let loop: ImportGraphEdge[] | undefined;
  for (const boundary of [...boundaries].sort()) {
    const found = shortestLoopThrough(boundary, group, successors);
    if (found && (!loop || found.length < loop.length)) loop = found;
  }
  if (!loop?.length) return undefined;
  const intoBoundary = (edge: ImportGraphEdge) => boundaries.has(edge.to!);
  const fromLowerLayer = loop.findIndex((edge) => intoBoundary(edge) && !boundaries.has(edge.from));
  const start = fromLowerLayer >= 0 ? fromLowerLayer : loop.findIndex(intoBoundary);
  return [...loop.slice(start), ...loop.slice(0, start)];
}

function shortestLoopThrough(
  start: string,
  group: ReadonlySet<string>,
  successors: ReadonlyMap<string, ImportGraphEdge[]>,
): ImportGraphEdge[] | undefined {
  const via = new Map<string, ImportGraphEdge>();
  let frontier = [start];
  while (frontier.length) {
    const next: string[] = [];
    for (const file of frontier) {
      for (const edge of successors.get(file) ?? []) {
        const target = edge.to!;
        if (!group.has(target)) continue;
        if (target === start) {
          const loop = [edge];
          for (let at = file; at !== start;) {
            const previous = via.get(at)!;
            loop.unshift(previous);
            at = previous.from;
          }
          return loop;
        }
        if (via.has(target)) continue;
        via.set(target, edge);
        next.push(target);
      }
    }
    frontier = next;
  }
  return undefined;
}
