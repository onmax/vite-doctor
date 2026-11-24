import { relative } from "pathe";
import {
  createRule,
  type ImportGraph,
  type ImportGraphEdge,
  type RuleContext,
} from "../../../core/index.js";
import { isRuntimeImportEdge } from "../../../core/internal/import-graph.js";
import { sha256 } from "../../../core/internal/utils.js";
import { diagnostics } from "../../../diagnostics.js";

const RULE_ID = "vite/hmr/no-circular-import-at-hmr-boundary";
const HOT_ACCEPT_RE = /import\.meta\.hot(?:\?\.|\.)accept(?:Exports)?\s*\(/;

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
        for (const cycle of graph.cycles) {
          const boundaries = new Set(cycle.files.filter((file) => isHmrBoundary(ctx, file)));
          if (!boundaries.size) continue;
          const loop = loopThroughBoundary(graph, cycle.files, cycle.path, boundaries);
          if (!loop) continue;
          const edge = loop[0]!;
          const boundary = edge.to!;
          const steps = [...loop.map((item) => path(item.from)), path(edge.from)].join(" → ");
          const kind = boundary.endsWith(".vue")
            ? "a Vue SFC, which @vitejs/plugin-vue makes accept its own updates in dev"
            : "a module that calls import.meta.hot.accept";
          const autoImports = loop.filter((item) => item.kind === "auto-import");
          const viaAutoImports = autoImports.length
            ? ` The loop runs through Nuxt auto-imports (${autoImports.map((item) => `\`${item.specifier}\``).join(", ")}), which Nuxt compiles to static imports in dev and build.`
            : "";
          ctx.report(
            diagnostics.VITE0029({
              why: `Circular import through the HMR boundary ${path(boundary)}: ${steps}.${viaAutoImports} ${path(boundary)} is ${kind}. When an edit inside this cycle reaches it, Vite marks the update as within a circular import, and the browser re-imports ${path(boundary)}, which re-runs the modules in the cycle. If that re-import throws, for example because a module reads a binding of the cycle before it is initialized, Vite reloads the whole page instead of applying the update.`,
              fix: `${cycleFix(ctx, edge, autoImports, path)} Do not decline HMR with import.meta.hot.decline() or suppress this Diagnostic to hide the cycle.`,
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
                message: describeEdge(item, path),
              })),
              // Keyed on the group rather than the loop, so reordering imports keeps baselined findings.
              fingerprint: sha256(`${RULE_ID}:${cycle.files.map(path).join("\n")}`),
              evidence: [
                {
                  kind: "graph",
                  file: boundary,
                  summary: `${path(boundary)} accepts HMR updates and is in a group of ${cycle.files.length} files joined by static runtime imports, re-exports, or Nuxt auto-imports.`,
                },
              ],
            },
          );
        }
      },
    };
  },
});

function describeEdge(edge: ImportGraphEdge, path: (file: string) => string): string {
  if (edge.kind === "auto-import")
    return `uses auto-imported \`${edge.specifier}\` → ${path(edge.to!)}`;
  return `${edge.kind === "re-export" ? "re-exports" : "imports"} '${edge.specifier}' → ${path(edge.to!)}`;
}

/**
 * Lazy loading only fits a component that a route record names, as in `component: Page`; any
 * other edge, and every auto-import, is cut by moving what the importer needs.
 */
function cycleFix(
  ctx: RuleContext,
  edge: ImportGraphEdge,
  autoImports: readonly ImportGraphEdge[],
  path: (file: string) => string,
): string {
  const from = path(edge.from);
  const to = path(edge.to!);
  if (isRouteComponentImport(ctx, edge))
    return `Break the cycle where ${from} imports the component ${to}: load it lazily in the route record, as in \`component: () => import('${edge.specifier}')\`, or move what ${from} needs from ${to} into a module that imports neither.`;
  const cut =
    edge.kind === "auto-import"
      ? `uses auto-imported \`${edge.specifier}\` from ${to}`
      : `imports ${to}`;
  const lazy = autoImports.length
    ? ` If ${autoImports.map((item) => `\`${item.specifier}\``).join(", ")} cannot move, call ${autoImports.length > 1 ? "them" : "it"} only inside functions, not at module top level, so the re-import does not read it before it is initialized; the cycle stays, but the update no longer throws.`
    : "";
  return `Break the cycle at the edge where ${from} ${cut}: move what ${from} needs into a module that neither side depends on.${lazy}`;
}

function isRouteComponentImport(ctx: RuleContext, edge: ImportGraphEdge): boolean {
  if (edge.kind !== "import" || !edge.to!.endsWith(".vue")) return false;
  const text = ctx.fs.readText(edge.from);
  if (!text) return false;
  const specifier = edge.specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const binding = new RegExp(`import\\s+([A-Za-z_$][\\w$]*)\\s+from\\s*["']${specifier}["']`).exec(
    text,
  )?.[1];
  return binding !== undefined && new RegExp(`\\bcomponent\\s*:\\s*${binding}\\b`).test(text);
}

function isHmrBoundary(ctx: RuleContext, file: string): boolean {
  if (file.endsWith(".vue")) return true;
  if (!/\.[cm]?[jt]sx?$/.test(file)) return false;
  const text = ctx.fs.readText(file);
  return text !== undefined && HOT_ACCEPT_RE.test(text);
}

/**
 * A shortest loop of the group that enters an HMR boundary, rotated to start at the edge into it.
 * The group's own loop is used when it already passes a boundary, so the path matches DOC0001.
 */
function loopThroughBoundary(
  graph: ImportGraph,
  files: readonly string[],
  path: readonly ImportGraphEdge[],
  boundaries: ReadonlySet<string>,
): ImportGraphEdge[] | undefined {
  let loop: readonly ImportGraphEdge[] | undefined = path.some((edge) => boundaries.has(edge.to!))
    ? path
    : undefined;
  if (!loop) {
    const group = new Set(files);
    for (const boundary of [...boundaries].sort()) {
      const found = shortestLoopThrough(graph, boundary, group);
      if (found && (!loop || found.length < loop.length)) loop = found;
    }
  }
  if (!loop?.length) return undefined;
  const intoBoundary = (edge: ImportGraphEdge) => boundaries.has(edge.to!);
  const fromLowerLayer = loop.findIndex((edge) => intoBoundary(edge) && !boundaries.has(edge.from));
  const start = fromLowerLayer >= 0 ? fromLowerLayer : loop.findIndex(intoBoundary);
  return [...loop.slice(start), ...loop.slice(0, start)];
}

function shortestLoopThrough(
  graph: ImportGraph,
  start: string,
  group: ReadonlySet<string>,
): ImportGraphEdge[] | undefined {
  const via = new Map<string, ImportGraphEdge>();
  let frontier = [start];
  while (frontier.length) {
    const next: string[] = [];
    for (const file of frontier) {
      for (const edge of graph.importsOf(file)) {
        const target = edge.to;
        if (!target || target === file || !group.has(target) || !isRuntimeImportEdge(edge))
          continue;
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
