import { dirname, isAbsolute, resolve } from "pathe";
import { createRule, type RuleContext, type SourceRange } from "../../../core/index.js";
import { parseScript } from "../../../core/internal/script.js";
import { diagnostics } from "../diagnostics.js";
import {
  collectStoreModules,
  findStoreUses,
  nuxtValueImport,
  setupRuntimes,
  type SetupStoreUse,
  type StoreModule,
  type StoreWithUses,
} from "./shared.js";

interface LocatedStore {
  store: StoreWithUses;
  module: StoreModule;
}

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

const VITE_EXTENSIONS = [".mjs", ".js", ".mts", ".ts", ".jsx", ".tsx", ".json"];
const NUXT_EXTENSIONS = [
  ".mjs",
  ".js",
  ".cjs",
  ".mts",
  ".ts",
  ".cts",
  ".tsx",
  ".jsx",
  ".vue",
  ".json",
];
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
    consumesEvidence: ["ast"],
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
        const edges = storeEdges(ctx, stores);
        const seen = new Set<string>();
        for (const runtime of setupRuntimes) {
          for (const cycle of cycles(
            stores,
            edges.filter((edge) => edge.use.runtimes & runtime),
          )) {
            reportCycle(ctx, cycle, runtime, seen);
          }
        }
      },
    };
  },
});

function storeEdges(ctx: RuleContext, stores: LocatedStore[]): StoreEdge[] {
  const edges: StoreEdge[] = [];
  const resolveUse = storeResolver(ctx, stores);
  for (const from of stores) {
    for (const use of from.store.uses) {
      const target = resolveUse(from, use);
      if (!target || target.store === from || !target.store.store.setup) continue;
      edges.push({ from, to: target.store, use, byName: target.byName });
    }
  }
  return edges;
}

function storeResolver(ctx: RuleContext, stores: LocatedStore[]) {
  const byFile = new Map<string, LocatedStore[]>();
  const programs = new Map<string, StoreModule["program"]>();
  const frameworks = new Map(
    ctx.project.workspacePackages?.map((item) => [
      resolve(ctx.project.root, item.root),
      item.framework,
    ]),
  );
  for (const store of stores) {
    const file = store.module.file;
    const local = byFile.get(file) ?? [];
    local.push(store);
    byFile.set(file, local);
    programs.set(file, store.module.program);
  }

  function moduleFile(from: string, source: string) {
    const framework = frameworks.get(packageRoot(ctx, from)) ?? ctx.project.framework;
    const extensions = framework === "nuxt" ? NUXT_EXTENSIONS : VITE_EXTENSIONS;
    const matches = new Set(
      importBases(ctx, from, source).flatMap((base) => {
        const file = importCandidates(base, extensions).find(
          (candidate) => byFile.has(candidate) || ctx.fs.stat(candidate)?.isFile(),
        );
        return file ? [file] : [];
      }),
    );
    return matches.size === 1 ? matches.values().next().value : undefined;
  }

  function program(file: string) {
    if (!programs.has(file)) {
      const text = ctx.fs.readText(file);
      programs.set(file, text && !file.endsWith(".vue") ? parseScript(file, text) : undefined);
    }
    return programs.get(file);
  }

  function declarationStore(file: string, declaration: StoreModule["program"], name: string) {
    const binding = declaration?.declarations?.find(
      (entry: StoreModule["program"]) => entry.id?.type === "Identifier" && entry.id.name === name,
    )?.id;
    return (
      binding &&
      byFile.get(file)?.find((candidate) => candidate.store.binding?.start === binding.start)
    );
  }

  // `null` means the export might exist but cannot be proven to be a store; `undefined` means absent.
  function exported(
    file: string,
    name: string,
    seen = new Set<string>(),
  ): LocatedStore | null | undefined {
    const key = `${file}\0${name}`;
    if (seen.has(key)) return undefined;
    const body = program(file)?.body;
    if (!body) return null;
    const path = new Set(seen).add(key);
    for (const statement of body) {
      if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue;
      const declaration = statement.declaration;
      if (declaration?.id?.name === name) return null;
      if (declaration?.type === "VariableDeclaration") {
        const store = declarationStore(file, declaration, name);
        if (store) return store;
        if (
          declaration.declarations.some((entry: StoreModule["program"]) =>
            bindsName(entry.id, name),
          )
        )
          return null;
      }
      for (const item of statement.specifiers ?? []) {
        if (item.exportKind === "type" || exportName(item.exported) !== name) continue;
        const local = exportName(item.local);
        if (!local) return null;
        if (statement.source) {
          const target = moduleFile(file, statement.source.value);
          return (target && exported(target, local, path)) || null;
        }
        for (const binding of body) {
          const store = declarationStore(file, binding.declaration ?? binding, local);
          if (store) return store;
          if (binding.type !== "ImportDeclaration" || binding.importKind === "type") continue;
          const imported = binding.specifiers.find(
            (entry: StoreModule["program"]) => entry.local.name === local,
          );
          if (imported?.type !== "ImportSpecifier" || imported.importKind === "type") continue;
          const target = moduleFile(file, binding.source.value);
          return (target && exported(target, exportName(imported.imported), path)) || null;
        }
        return null;
      }
    }
    let match: LocatedStore | undefined;
    for (const statement of body) {
      if (statement.type !== "ExportAllDeclaration" || statement.exportKind === "type") continue;
      if (statement.exported) {
        if (exportName(statement.exported) === name) return null;
        continue;
      }
      const target = moduleFile(file, statement.source.value);
      if (!target) return null;
      const store = exported(target, name, path);
      if (store === null || (store && match && match !== store)) return null;
      match ??= store;
    }
    return match;
  }

  return (from: LocatedStore, use: SetupStoreUse) => {
    const { target } = use;
    const file = from.module.file;
    const ownPackage = packageRoot(ctx, file);
    const nuxt = nuxtForFile(ctx, file);
    if (target.kind === "local") {
      const store = byFile.get(file)?.find((item) => item.store.binding?.start === target.start);
      return store && { store, byName: false };
    }
    if (target.kind === "import" && target.source !== "#imports") {
      const imported = moduleFile(file, target.source);
      const store = imported && exported(imported, target.name);
      return store ? { store, byName: false } : undefined;
    }
    if (target.kind === "auto-import" && nuxt?.autoImportEnabled === false) return undefined;
    if (nuxt?.autoImportsAuthoritative) {
      const registration = nuxtValueImport(nuxt, target.name);
      const imported = registration && moduleFile(file, registration.from);
      const store = imported && exported(imported, registration.name);
      return store ? { store, byName: false } : undefined;
    }
    if (target.kind === "import" || nuxt?.autoImports.has(target.name)) return undefined;
    const named = [
      ...new Set([...byFile.keys()].flatMap((candidate) => exported(candidate, target.name) ?? [])),
    ];
    const samePackage = named.filter((store) => packageRoot(ctx, store.module.file) === ownPackage);
    const candidates = samePackage.length ? samePackage : named;
    return candidates.length === 1 ? { store: candidates[0]!, byName: true } : undefined;
  };
}

function exportName(node: StoreModule["program"]): string {
  return node?.name ?? node?.value;
}

function bindsName(pattern: StoreModule["program"], name: string): boolean {
  switch (pattern?.type) {
    case "Identifier":
      return pattern.name === name;
    case "RestElement":
      return bindsName(pattern.argument, name);
    case "AssignmentPattern":
      return bindsName(pattern.left, name);
    case "ArrayPattern":
      return pattern.elements.some((element: StoreModule["program"]) => bindsName(element, name));
    case "ObjectPattern":
      return pattern.properties.some((property: StoreModule["program"]) =>
        bindsName(property.value ?? property.argument, name),
      );
    default:
      return false;
  }
}

function importBases(ctx: RuleContext, from: string, specifier: string): string[] {
  const bare = specifier.split("?")[0]!;
  const root = ctx.project.root;
  const own = packageRoot(ctx, from);
  let bases: string[] = [];
  if (isAbsolute(bare)) bases = [bare];
  else if (bare.startsWith("./") || bare.startsWith("../")) bases = [resolve(dirname(from), bare)];
  else if (/^(?:~~|@@)\//.test(bare))
    bases = [own, root].map((base) => resolve(base, bare.slice(3)));
  else if (/^[~@]\//.test(bare)) {
    const appDir = nuxtForFile(ctx, from)?.appDir;
    bases = [
      ...(appDir ? [appDir] : []),
      ...[own, root].flatMap((base) => [resolve(base, "app"), resolve(base, "src"), base]),
    ].map((base) => resolve(base, bare.slice(2)));
  }
  return bases;
}

function importCandidates(base: string, extensions: string[]): string[] {
  const ts = base.replace(/\.([cm]?)js(x?)$/, ".$1ts$2");
  return [
    base,
    ...(ts === base ? [] : [ts]),
    ...extensions.map((extension) => `${base}${extension}`),
    ...extensions.map((extension) => `${base}/index${extension}`),
  ];
}

function nuxtForFile(ctx: RuleContext, file: string) {
  const ownPackage = packageRoot(ctx, file);
  return (
    ctx.project.workspaceNuxt?.find((item) => resolve(ctx.project.root, item.root) === ownPackage)
      ?.nuxt ?? ctx.project.nuxt
  );
}

function packageRoot(ctx: RuleContext, file: string): string {
  const roots = (ctx.project.workspacePackages ?? [])
    .map((item) => resolve(ctx.project.root, item.root))
    .filter((root) => file.startsWith(`${root}/`))
    .sort((left, right) => right.length - left.length);
  return roots[0] ?? ctx.project.root;
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
  const key = JSON.stringify(sites.map((site) => site.location));
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
