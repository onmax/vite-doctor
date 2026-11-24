import { createRule, type RuleContext, type SourceRange } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";
import {
  collectStoreModules,
  findStoreUses,
  importResolutionEvidence,
  nuxtForFile,
  setupRuntimes,
  storeResolver,
  type EnvironmentResolution,
  type LocatedStore as Located,
  type SetupStoreUse,
  type StoreWithUses,
} from "./shared.js";

type LocatedStore = Located<StoreWithUses>;

interface StoreEdge {
  from: LocatedStore;
  to: LocatedStore;
  use: SetupStoreUse;
  /** Matched by its exported name because no import led to its definition. */
  byName: boolean;
}

interface ReadSite {
  edge: StoreEdge;
  file: string;
  range: SourceRange;
  location: string;
}

const REMEDIATION =
  "Defer every reported read to a computed() getter or an action that runs after setup, or break the cycle by moving a useStore() call out of setup.";

export const noCircularSetupStateRead = createRule({
  meta: {
    id: "pinia/stores/no-circular-setup-state-read",
    title: "Don't let setup stores read each other's state during setup",
    description: "Report eager state reads along cycles of setup-store initialization.",
    why: "Pinia registers a store before running its setup. If eager store calls form a cycle, a read can reach a store before it has finished initializing. A single eager read can fail, depending on which store is created first.",
    recommendedReplacement:
      "Defer every reported read to a computed() getter or an action that runs after setup, or break the cycle by moving a useStore() call out of setup.",
    examples: [
      {
        title: "Read the other store in a getter",
        language: "ts",
        invalid:
          "// stores/x.ts\nexport const useXStore = defineStore('x', () => {\n  const y = useYStore()\n  const greeting = `Hi ${y.name}`\n  return { name: ref('X'), greeting }\n})\n\n// stores/y.ts\nexport const useYStore = defineStore('y', () => {\n  const x = useXStore()\n  const { name: friend } = storeToRefs(x)\n  return { name: ref('Y'), friend }\n})",
        valid:
          "// stores/x.ts\nexport const useXStore = defineStore('x', () => {\n  const y = useYStore()\n  const greeting = computed(() => `Hi ${y.name}`)\n  return { name: ref('X'), greeting }\n})\n\n// stores/y.ts\nexport const useYStore = defineStore('y', () => {\n  const x = useXStore()\n  const friend = computed(() => x.name)\n  return { name: ref('Y'), friend }\n})",
      },
    ],
    category: "stores",
    severity: "error",
    confidence: "heuristic-high",
    fixable: false,
    diagnosticCodes: ["PINIA0003"],
    docsUrl: "https://pinia.vuejs.org/cookbook/composing-stores.html",
    execution: "workspace",
    cacheScope: "none",
    requires: { crossFile: true },
    requiresContext: ["cross-file"],
    consumesEvidence: ["ast", "runtime"],
    cost: "medium",
  },
  create(ctx) {
    return {
      async onWorkspaceEnd() {
        const stores = (await collectStoreModules(ctx)).flatMap((module) =>
          findStoreUses(module.program, module.text, nuxtForFile(ctx, module.file)).map(
            (store) => ({
              store,
              module,
            }),
          ),
        );
        const environments = importResolutionEvidence(ctx.project.runtimeEvidence?.vite);
        const seen = new Set<string>();
        for (const runtime of Object.values(setupRuntimes)) {
          const resolutions = environments.length
            ? environments.filter((environment) => environment.runtime === runtime)
            : [undefined];
          for (const resolution of resolutions) {
            const edges = storeEdges(ctx, stores, runtime, resolution);
            for (const cycle of cycles(stores, edges)) reportCycle(ctx, cycle, runtime, seen);
          }
        }
      },
    };
  },
});

function storeEdges(
  ctx: RuleContext,
  stores: LocatedStore[],
  runtime: number,
  resolution: EnvironmentResolution | undefined,
): StoreEdge[] {
  const edges: StoreEdge[] = [];
  const { resolveUse } = storeResolver(ctx, stores, resolution);
  for (const from of stores) {
    for (const use of from.store.uses) {
      if (!(use.runtimes & runtime)) continue;
      const target = resolveUse(from.module.file, use.target);
      if (!target || target.store === from || !target.store.store.setup) continue;
      edges.push({ from, to: target.store, use, byName: target.byName });
    }
  }
  return edges;
}

/** Strongly connected groups of two or more stores; every read between them lies on a cycle. */
function cycles(stores: LocatedStore[], edges: StoreEdge[]): StoreEdge[][] {
  const outgoing = new Map<LocatedStore, StoreEdge[]>();
  for (const edge of edges) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  const index = new Map<LocatedStore, number>();
  const low = new Map<LocatedStore, number>();
  const stack: LocatedStore[] = [];
  const onStack = new Set<LocatedStore>();
  const groups: LocatedStore[][] = [];
  const connect = (store: LocatedStore) => {
    index.set(store, index.size);
    low.set(store, index.get(store)!);
    stack.push(store);
    onStack.add(store);
    for (const { to } of outgoing.get(store) ?? []) {
      if (!index.has(to)) {
        connect(to);
        low.set(store, Math.min(low.get(store)!, low.get(to)!));
      } else if (onStack.has(to)) low.set(store, Math.min(low.get(store)!, index.get(to)!));
    }
    if (low.get(store) !== index.get(store)) return;
    const group: LocatedStore[] = [];
    let member: LocatedStore;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      group.push(member);
    } while (member !== store);
    if (group.length > 1) groups.push(group);
  };
  for (const store of stores) if (!index.has(store)) connect(store);
  return groups.map((group) => {
    const members = new Set(group);
    return edges
      .filter((read) => members.has(read.from) && members.has(read.to))
      .sort(
        (left, right) =>
          left.from.module.displayPath.localeCompare(right.from.module.displayPath) ||
          left.use.callee.start - right.use.callee.start,
      );
  });
}

function reportCycle(ctx: RuleContext, cycle: StoreEdge[], runtime: number, seen: Set<string>) {
  const sites: ReadSite[] = cycle.flatMap((edge) =>
    edge.use.reads
      .filter((site) => site.runtimes & runtime)
      .map((site) => {
        const { file, displayPath, text } = edge.from.module;
        const range = ctx.helpers.rangeFromOffsets(file, text, site.start, site.end);
        return { edge, file, range, location: `${displayPath}:${range.line}:${range.column}` };
      }),
  );
  const [primary, ...others] = sites;
  if (!primary) return;
  const storeKey = ({ module, store }: LocatedStore) => `${module.file}:${store.binding?.start}`;
  const key = JSON.stringify([
    [...new Set(cycle.map(({ from }) => storeKey(from)))].sort(),
    sites.map(({ location, edge }) => [location, storeKey(edge.to)]),
  ]);
  if (seen.has(key)) return;
  seen.add(key);
  const ids = [...new Set(cycle.map((edge) => `"${edge.from.store.id}"`))];
  const steps = sites.map(
    ({ edge, location }) =>
      `store "${edge.from.store.id}" reads ${edge.use.callee.name}() (store "${edge.to.store.id}") at ${location}`,
  );
  const byName = cycle.filter((edge) => edge.byName);
  const partial = byName.length
    ? ` Doctor found no import for ${[...new Set(byName.map((read) => `${read.use.callee.name}()`))].join(", ")}, so it matched each call to the only store exported under that name, as an auto-import from @pinia/nuxt or unplugin-auto-import would resolve it; check that no other store is auto-imported under that name.`
    : "";
  ctx.report(
    diagnostics.PINIA0003({
      why: `Setup stores ${ids.join(", ")} form a cycle of eager store calls: ${steps.join("; ")}. If a store being read initializes first, Pinia can reach that read before the store finishes setup.${partial}`,
      fix: REMEDIATION,
      sources: sites.map((site) => site.location),
    }),
    {
      ruleId: "pinia/stores/no-circular-setup-state-read",
      severity: ctx.severity,
      category: "stores",
      file: primary.file,
      range: primary.range,
      confidence: byName.length ? "heuristic-medium" : "heuristic-high",
      related: others.map((site) => ({
        file: site.file,
        range: site.range,
        message: `Store "${site.edge.from.store.id}" reads store "${site.edge.to.store.id}" during setup`,
      })),
      evidence: sites.map((site) => ({
        kind: "ast" as const,
        file: site.file,
        range: site.range,
        summary: `Setup store "${site.edge.from.store.id}" reads ${site.edge.use.callee.name}() during initialization${site.edge.byName ? ", matched by exported name" : ""}.`,
      })),
    },
  );
}
