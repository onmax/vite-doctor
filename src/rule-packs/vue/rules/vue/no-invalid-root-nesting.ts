import { relative, resolve } from "pathe";
import type {
  ComponentNode,
  ComponentRootFact,
  ComponentUsageEdge,
  ComponentUsageGraph,
  NuxtProjectInfo,
  RuleContext,
} from "../../../../core/index.js";
import { diagnostics } from "../../diagnostics.js";
import { displayName } from "./component-usage.js";
import { parserMovesChild } from "./html-nesting.js";
import { createRule } from "./shared.js";
import { hydrationEvidence, hydrationNuxtApp } from "./ssr-evidence.js";

const RULE_ID = "vue/ssr/no-invalid-root-nesting";

export const noInvalidRootNesting = createRule({
  meta: {
    id: RULE_ID,
    title: "Render component roots where the HTML parser keeps them",
    category: "ssr",
    severity: "warn",
    confidence: "heuristic-high",
    fixable: false,
    execution: "workspace",
    requires: { vue: true, crossFile: true },
    requiresContext: ["cross-file"],
    consumesEvidence: ["facts", "graph"],
    cost: "small",
    docsUrl: "https://vuejs.org/guide/scaling-up/ssr.html#hydration-mismatch",
  },
  create(ctx) {
    return {
      async onWorkspaceEnd() {
        const graph = await ctx.inventory.componentUsage();
        const apps = new Map<string, NuxtProjectInfo>();
        const appsWithInlineRules = new Set<NuxtProjectInfo>();
        for (const node of graph.components.values()) {
          const app = hydrationNuxtApp(ctx, node.relativePath);
          if (!app) continue;
          apps.set(node.file, app);
          if (node.facts.definesRouteRules) appsWithInlineRules.add(app);
        }
        const withoutHydration = componentsWithoutHydration(ctx, graph, apps);
        const evidenceByFile = new Map<string, string | undefined>();
        for (const node of graph.components.values()) {
          for (const edge of node.callers) {
            const parent = edge.usage.parent;
            if (
              !parent?.element ||
              parent.foreign ||
              skipsHydration(edge) ||
              withoutHydration.has(edge.from)
            )
              continue;
            const root = node.facts.roots.find((item) => movedRoot(parent.tag, item));
            if (!root) continue;
            if (!evidenceByFile.has(edge.from))
              evidenceByFile.set(
                edge.from,
                hydrationEvidence(ctx, relative(ctx.project.root, edge.from), appsWithInlineRules),
              );
            const evidence = evidenceByFile.get(edge.from);
            if (!evidence) continue;
            report(ctx, node, edge, parent.tag, root, evidence);
          }
        }
      },
    };
  },
});

function skipsHydration(edge: ComponentUsageEdge): boolean {
  return edge.clientOnlySlot === true || edge.nuxtMode === "client" || edge.nuxtMode === "server";
}

function componentsWithoutHydration(
  ctx: RuleContext,
  graph: ComponentUsageGraph,
  apps: ReadonlyMap<string, NuxtProjectInfo>,
): Set<string> {
  const boundaryTargets = new Set<string>();
  for (const node of graph.components.values()) {
    if (node.callers.some(skipsHydration)) boundaryTargets.add(node.file);
  }
  if (!boundaryTargets.size) return boundaryTargets;
  const behindBoundary = reachComponents(graph, boundaryTargets, () => true);
  const potentialEntries = new Set<string>();
  const nuxtEntries = new Set<string>();
  for (const app of new Set(apps.values())) {
    const resolved = app.manifest?.resolvedApp;
    for (const source of [
      resolved?.mainComponent,
      ...Object.values(resolved?.layouts ?? {}),
      ...(app.manifest?.pages ?? []).map((page) => page.file),
    ]) {
      if (source) nuxtEntries.add(resolve(ctx.project.root, source));
    }
  }
  for (const node of graph.components.values()) {
    if (
      !behindBoundary.has(node.file) ||
      node.indirectImporters.length ||
      nuxtEntries.has(node.file) ||
      (apps.has(node.file) &&
        /(?:^|\/)(?:(?:pages|layouts)\/|(?:app|error)\.vue$)/.test(node.relativePath))
    )
      potentialEntries.add(node.file);
  }
  const reachable = reachComponents(graph, potentialEntries, (edge) => !skipsHydration(edge));
  return new Set([...behindBoundary].filter((file) => !reachable.has(file)));
}

function reachComponents(
  graph: ComponentUsageGraph,
  starts: ReadonlySet<string>,
  follows: (edge: ComponentUsageEdge) => boolean,
): Set<string> {
  const seen = new Set(starts);
  const remaining = [...starts];
  while (remaining.length) {
    const node = graph.components.get(remaining.pop()!);
    for (const edge of node?.renders ?? []) {
      if (!edge.target || seen.has(edge.target) || !follows(edge)) continue;
      seen.add(edge.target);
      remaining.push(edge.target);
    }
  }
  return seen;
}

/** Whether every branch of the root is an element the parser moves out of `parent`. */
function movedRoot(parent: string, root: ComponentRootFact): boolean {
  return root.branches.every(
    (branch) => branch.kind === "element" && parserMovesChild(parent, branch.tag!),
  );
}

function report(
  ctx: RuleContext,
  node: ComponentNode,
  edge: ComponentUsageEdge,
  parent: string,
  root: ComponentRootFact,
  evidence: string,
): void {
  const name = displayName(node);
  const tags = [...new Set(root.branches.map((branch) => `<${branch.tag}>`))].join(" or ");
  ctx.report(
    diagnostics.VUE0052({
      why: `<${edge.usage.tag}> sits directly inside <${parent}>, and ${name} renders ${tags} at its root. The server sends that nesting as HTML, but the browser's HTML parser cannot keep ${tags} inside <${parent}>, so it closes, drops, or moves elements before Vue hydrates. Vue then finds different DOM than it rendered and logs "Hydration node mismatch" or "Hydration children mismatch". Doctor treats the file as server-rendered because ${evidence}.`,
      fix:
        parent === "table" && root.branches.every((branch) => branch.tag === "tr")
          ? `Add an explicit <tbody> inside <table> and place <${edge.usage.tag}> inside it.`
          : `Place <${edge.usage.tag}> inside an element that can contain ${tags}, or change the root of ${name} to an element that is valid inside <${parent}>.`,
    }),
    {
      file: edge.from,
      range: edge.usage.range,
      confidence: "heuristic-high",
      evidence: [
        {
          kind: "graph",
          file: node.file,
          range: root.branches[0]?.range,
          summary: `${name} renders ${tags} at its root, which Vue's HTML nesting check rejects inside <${parent}>.`,
        },
      ],
      related: [
        {
          file: node.file,
          range: root.branches[0]?.range,
          message: `${name} renders ${tags} here`,
        },
      ],
    },
  );
}
