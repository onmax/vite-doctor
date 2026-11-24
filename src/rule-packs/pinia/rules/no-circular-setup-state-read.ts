import { dirname, resolve } from "pathe";
import { createRule, type RuleContext, type SourceRange } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";
import {
  collectStoreModules,
  findStoreUses,
  type SetupStoreUse,
  type StoreModule,
  type StoreWithUses,
} from "./shared.js";

interface LocatedStore {
  store: StoreWithUses;
  module: StoreModule;
}

interface StoreRead {
  from: LocatedStore;
  to: LocatedStore;
  use: SetupStoreUse;
  /** Matched by its exported name because no import led to its definition. */
  byName: boolean;
}

interface ReadSite {
  read: StoreRead;
  file: string;
  range: SourceRange;
  location: string;
}

const SCRIPT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue"];

export const noCircularSetupStateRead = createRule({
  meta: {
    id: "pinia/stores/no-circular-setup-state-read",
    title: "Don't let setup stores read each other's state during setup",
    description:
      "Report setup stores that read each other's state at the top level of their setup functions, directly or through a longer cycle.",
    why: "Pinia registers a store before it runs the store's setup function, so stores can call each other's useStore() during setup. When two setup stores both read the other's state at the top level of setup, whichever is created first runs the other's setup while its own is unfinished, and that setup reads properties of a store that has none yet: values are undefined, and storeToRefs() returns no refs. Pinia's docs say two stores cannot both read each other's state directly in their setup function; reads inside getters (computed()) and actions run later and are supported.",
    recommendedReplacement:
      "Keep the useStore() call at the top level of the setup function, and move the read of the other store into a computed() getter or an action, in at least one store of the cycle.",
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
    consumesEvidence: ["ast"],
    cost: "medium",
  },
  create(ctx) {
    return {
      async onWorkspaceEnd() {
        const stores = (await collectStoreModules(ctx)).flatMap((module) =>
          findStoreUses(module.program, module.text).map((store) => ({ store, module })),
        );
        const reads = storeReads(ctx, stores);
        for (const cycle of cycles(stores, reads)) reportCycle(ctx, cycle);
      },
    };
  },
});

function storeReads(ctx: RuleContext, stores: LocatedStore[]): StoreRead[] {
  const reads: StoreRead[] = [];
  for (const from of stores) {
    for (const use of from.store.uses) {
      if (!use.reads.length) continue;
      const target = resolveUse(ctx, stores, from, use);
      if (!target || target.store === from || !target.store.store.setup) continue;
      reads.push({ from, to: target.store, use, byName: target.byName });
    }
  }
  return reads;
}

function resolveUse(
  ctx: RuleContext,
  stores: LocatedStore[],
  from: LocatedStore,
  use: SetupStoreUse,
): { store: LocatedStore; byName: boolean } | undefined {
  const { target } = use;
  const named = stores.filter((store) => store.store.binding?.name === target.name);
  if (target.kind === "local") {
    const local = named.filter((store) => store.module === from.module);
    return local.length === 1 ? { store: local[0]!, byName: false } : undefined;
  }
  if (target.kind === "import") {
    if (!/^(?:\.{1,2}\/|[~@]{1,2}\/|#)/.test(target.source)) return undefined;
    const files = importCandidates(ctx, from.module.file, target.source);
    const imported = named.filter((store) => files.has(store.module.file));
    if (imported.length === 1) return { store: imported[0]!, byName: false };
    if (imported.length > 1) return undefined;
  }
  const ownPackage = packageRoot(ctx, from.module.file);
  const samePackage = named.filter((store) => packageRoot(ctx, store.module.file) === ownPackage);
  const candidates = samePackage.length ? samePackage : named;
  return candidates.length === 1 ? { store: candidates[0]!, byName: true } : undefined;
}

function importCandidates(ctx: RuleContext, from: string, specifier: string): Set<string> {
  const bare = specifier.split("?")[0]!;
  const root = ctx.project.root;
  const own = packageRoot(ctx, from);
  let bases: string[] = [];
  if (bare.startsWith("./") || bare.startsWith("../")) bases = [resolve(dirname(from), bare)];
  else if (/^(?:~~|@@)\//.test(bare))
    bases = [own, root].map((base) => resolve(base, bare.slice(3)));
  else if (/^[~@]\//.test(bare))
    bases = [
      ...(ctx.project.nuxt?.appDir ? [ctx.project.nuxt.appDir] : []),
      ...[own, root].flatMap((base) => [resolve(base, "app"), resolve(base, "src"), base]),
    ].map((base) => resolve(base, bare.slice(2)));
  const files = new Set<string>();
  for (const base of bases) {
    files.add(base);
    files.add(base.replace(/\.([cm]?)js(x?)$/, ".$1ts$2"));
    for (const extension of SCRIPT_EXTENSIONS) {
      files.add(`${base}${extension}`);
      files.add(`${base}/index${extension}`);
    }
  }
  return files;
}

function packageRoot(ctx: RuleContext, file: string): string {
  const roots = (ctx.project.workspacePackages ?? [])
    .map((item) => resolve(ctx.project.root, item.root))
    .filter((root) => file.startsWith(`${root}/`))
    .sort((left, right) => right.length - left.length);
  return roots[0] ?? ctx.project.root;
}

/** Strongly connected groups of two or more stores; every read between them lies on a cycle. */
function cycles(stores: LocatedStore[], reads: StoreRead[]): StoreRead[][] {
  const outgoing = new Map<LocatedStore, StoreRead[]>();
  for (const read of reads) outgoing.set(read.from, [...(outgoing.get(read.from) ?? []), read]);
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
    return reads
      .filter((read) => members.has(read.from) && members.has(read.to))
      .sort(
        (left, right) =>
          left.from.module.displayPath.localeCompare(right.from.module.displayPath) ||
          left.use.callee.start - right.use.callee.start,
      );
  });
}

function reportCycle(ctx: RuleContext, cycle: StoreRead[]) {
  const sites: ReadSite[] = cycle.flatMap((read) =>
    read.use.reads.map((site) => {
      const { file, displayPath, text } = read.from.module;
      const range = ctx.helpers.rangeFromOffsets(file, text, site.start, site.end);
      return { read, file, range, location: `${displayPath}:${range.line}:${range.column}` };
    }),
  );
  const [primary, ...others] = sites;
  if (!primary) return;
  const ids = [...new Set(cycle.map((read) => `"${read.from.store.id}"`))];
  const steps = cycle.map((read) => {
    const first = sites.find((site) => site.read === read)!;
    return `store "${read.from.store.id}" reads ${read.use.callee.name}() (store "${read.to.store.id}") at ${first.location}`;
  });
  const byName = cycle.filter((read) => read.byName);
  const partial = byName.length
    ? ` Doctor found no import for ${[...new Set(byName.map((read) => `${read.use.callee.name}()`))].join(", ")}, so it matched each call to the only store exported under that name, as an auto-import from @pinia/nuxt or unplugin-auto-import would resolve it; check that no other store is auto-imported under that name.`
    : "";
  ctx.report(
    diagnostics.PINIA0003({
      why: `Setup stores ${ids.join(", ")} read each other's state at the top level of their setup functions: ${steps.join("; ")}. Pinia registers a store before running its setup function, so whichever of these stores is created first runs the others' setup while its own is unfinished, and their reads of it return undefined.${partial}`,
      fix: "Move the read of the other store into a getter (computed()) or an action in at least one store of the cycle, and keep the useStore() call at the top level of the setup function. Don't move state between the stores, or wrap the useStore() call in a dynamic import, to silence this.",
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
        message: `Store "${site.read.from.store.id}" reads store "${site.read.to.store.id}" during setup`,
      })),
      evidence: sites.map((site) => ({
        kind: "ast" as const,
        file: site.file,
        range: site.range,
        summary: `Setup store "${site.read.from.store.id}" reads ${site.read.use.callee.name}() at the top level of its setup function${site.read.byName ? ", matched by exported name" : ""}.`,
      })),
    },
  );
}
