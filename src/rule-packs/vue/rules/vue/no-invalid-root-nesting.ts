import { relative, resolve } from "pathe";
import type {
  ComponentNode,
  ComponentRootFact,
  ComponentUsageEdge,
  ComponentUsageGraph,
  NuxtProjectInfo,
  RuleContext,
} from "../../../../core/index.js";
import { pascalCase } from "../../../../core/internal/component-facts.js";
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
        const appsWithPossibleInlineSsrOptOut = new Set<NuxtProjectInfo>();
        for (const node of graph.components.values()) {
          const app = hydrationNuxtApp(ctx, node.relativePath);
          if (!app) continue;
          apps.set(node.file, app);
          if (node.facts.inlineRouteRulesMayDisableSsr) appsWithPossibleInlineSsrOptOut.add(app);
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
                hydrationEvidence(
                  ctx,
                  relative(ctx.project.root, edge.from),
                  appsWithPossibleInlineSsrOptOut,
                ),
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

function skipsHydration(edge: Pick<ComponentUsageEdge, "clientOnlySlot" | "nuxtMode">): boolean {
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
    for (const edge of node.dynamicRenders ?? [])
      if (skipsHydration(edge)) boundaryTargets.add(edge.target);
  }
  if (!boundaryTargets.size) return boundaryTargets;
  const behindBoundary = reachComponents(graph, boundaryTargets, () => true);
  const potentialEntries = new Set<string>();
  const nuxtEntries = new Set<string>();
  const preparedGlobals = new Set<string>();
  for (const app of new Set(apps.values())) {
    for (const component of app.components.values())
      if (component.global) preparedGlobals.add(resolve(ctx.project.root, component.file));
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
    const app = apps.get(node.file);
    const unindexedGlobal =
      app &&
      !preparedGlobals.has(node.file) &&
      node.file.startsWith(`${app.appDir}/components/`) &&
      /\.global(?:\.island)?\.vue$/.test(node.file);
    if (
      !behindBoundary.has(node.file) ||
      node.hasUntrackedImporter ||
      nuxtEntries.has(node.file) ||
      unindexedGlobal ||
      (app && /(?:^|\/)(?:(?:pages|layouts)\/|(?:app|error)\.vue$)/.test(node.relativePath))
    )
      potentialEntries.add(node.file);
  }
  const reachable = reachComponents(
    graph,
    potentialEntries,
    (edge) => !skipsHydration(edge),
    possibleSsrTargets(graph, apps, behindBoundary),
  );
  return new Set([...behindBoundary].filter((file) => !reachable.has(file)));
}

function possibleSsrTargets(
  graph: ComponentUsageGraph,
  apps: ReadonlyMap<string, NuxtProjectInfo>,
  behindBoundary: ReadonlySet<string>,
): (node: ComponentNode) => Iterable<string> {
  const candidates = new Map<NuxtProjectInfo | undefined, string[]>();
  const named = new Map<NuxtProjectInfo, Map<string, string[]>>();
  for (const file of behindBoundary) {
    const app = apps.get(file);
    const files = candidates.get(app) ?? [];
    if (!candidates.has(app)) candidates.set(app, files);
    files.push(file);
    if (!app) continue;
    const names = named.get(app) ?? new Map<string, string[]>();
    if (!named.has(app)) named.set(app, names);
    const segments = graph.components
      .get(file)!
      .relativePath.replace(/(?:\.(?:client|server))?\.vue$/, "")
      .split("/");
    let name = "";
    for (const segment of segments.reverse()) {
      const part = pascalCase(segment);
      if (name.startsWith(part)) continue;
      name = part + name;
      const targets = names.get(name) ?? [];
      if (!names.has(name)) names.set(name, targets);
      targets.push(file);
    }
  }

  return function* (node) {
    const app = apps.get(node.file);
    if (node.hasUnresolvedDynamicRender) {
      yield* candidates.get(app) ?? [];
      candidates.delete(app);
    }
    const names = app && named.get(app);
    if (!names) return;
    for (const edge of node.renders) {
      if (edge.unresolvedNuxtName && !skipsHydration(edge))
        yield* names.get(edge.unresolvedNuxtName) ?? [];
    }
  };
}

function reachComponents(
  graph: ComponentUsageGraph,
  starts: ReadonlySet<string>,
  follows: (edge: Pick<ComponentUsageEdge, "clientOnlySlot" | "nuxtMode">) => boolean,
  possibleTargets?: (node: ComponentNode) => Iterable<string>,
): Set<string> {
  const seen = new Set(starts);
  const remaining = [...starts];
  const enqueue = (target: string) => {
    if (seen.has(target)) return;
    seen.add(target);
    remaining.push(target);
  };
  while (remaining.length) {
    const node = graph.components.get(remaining.pop()!);
    if (!node) continue;
    for (const edge of node.renders) if (edge.target && follows(edge)) enqueue(edge.target);
    for (const edge of node.dynamicRenders ?? []) if (follows(edge)) enqueue(edge.target);
    if (possibleTargets) for (const target of possibleTargets(node)) enqueue(target);
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
