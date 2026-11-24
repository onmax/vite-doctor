import { isBuiltin } from "node:module";
import { relative } from "pathe";
import {
  createRule,
  type DiagnosticEvidence,
  type ImportGraph,
  type ImportGraphEdge,
} from "../../../core/index.js";
import { diagnostics } from "../../../diagnostics.js";
import {
  buildModuleFile,
  buildDiagnosticFingerprint,
  BUILD_EVIDENCE_RULE,
  readBuildEvidence,
  type ViteBuildEnvironment,
  type ViteBuildEvidence,
} from "./build-evidence.js";

const RULE_ID = BUILD_EVIDENCE_RULE;

interface ClientModule {
  file: string;
  id: string;
  environment: ViteBuildEnvironment;
  reads: ViteBuildEnvironment["browserStubReads"];
}

export const noNodeBuiltinInClientChunk = createRule({
  meta: {
    id: RULE_ID,
    title: "Keep Node built-in code out of client chunks",
    category: "ssr",
    severity: "warn",
    confidence: "runtime-backed",
    docsUrl:
      "https://vite.dev/guide/troubleshooting.html#module-externalized-for-browser-compatibility",
    execution: "workspace",
    requires: { crossFile: true },
    requiresContext: ["cross-file"],
    consumesEvidence: ["runtime", "graph"],
    determinism: "runtime-dependent",
    cost: "small",
  },
  create(ctx) {
    return {
      async onWorkspaceEnd() {
        const evidence = readBuildEvidence(ctx.project.runtimeEvidence?.vite);
        if (!evidence) return;
        const modules = clientStubReaders(evidence);
        if (!modules.length) return;
        const graph = await ctx.inventory.importGraph();
        const path = (file: string) => relative(ctx.project.root, file);
        for (const module of modules) {
          const builtins = graph
            .importsOf(module.file)
            .filter(
              (edge) =>
                !edge.typeOnly &&
                isBuiltin(edge.specifier) &&
                module.reads.some(
                  (read) => read.specifier === edge.specifier && read.start === edge.range?.start,
                ),
            );
          const first = builtins[0];
          if (!first) continue;
          const names = [...new Set(builtins.map((edge) => edge.specifier))];
          const list = names.map((name) => `'${name}'`).join(", ");
          const chunks = [
            ...new Set(
              module.reads
                .filter((read) =>
                  builtins.some(
                    (edge) => edge.specifier === read.specifier && edge.range?.start === read.start,
                  ),
                )
                .map((read) => read.chunk),
            ),
          ].join(", ");
          const chain = importChain(module.environment, module.id);
          const steps = chain?.map((id) => displayId(evidence, id, path)).join(" → ");
          const environment = module.environment.name;
          const facts: DiagnosticEvidence[] = [
            {
              kind: "runtime",
              file: module.file,
              summary: `Vite's ${environment} environment (consumer: client) bundled ${path(module.file)} into ${chunks}, and the rendered chunk code still reads the empty module Vite substitutes for Node built-ins in client builds.`,
            },
            chain
              ? {
                  kind: "graph",
                  summary: `Client import chain from Vite's module graph: ${steps}.`,
                }
              : {
                  kind: "graph",
                  summary: `Evidence is partial: Vite's module graph for the ${environment} environment has no importer path from an entry to ${path(module.file)}, so Doctor reports the chunk without the chain.`,
                },
          ];
          ctx.report(
            diagnostics.VITE0033({
              why: `${path(module.file)} imports ${list} and ends up in the client chunk ${chunks}${steps ? ` through ${steps}` : ""}. In client builds Vite resolves Node built-ins to an empty module, so every value the code reads from ${list} is undefined in the browser, and the server code it belongs to ships to every visitor.`,
              fix: `Keep ${path(module.file)} out of client code: import it only from server entries, server routes, or code that the bundler removes from client builds, such as an import.meta.env.SSR branch with a dynamic import(). Move whatever the client needs from ${path(module.file)} into a module that does not import ${list}.`,
            }),
            {
              file: module.file,
              range: first.range,
              related: chain ? chainLocations(evidence, graph, chain, path) : undefined,
              fingerprint: buildDiagnosticFingerprint(path(module.file), environment),
              evidence: facts,
            },
          );
        }
      },
    };
  },
});

/** Bundled files in client environments whose rendered code reads Vite's browser stub. */
function clientStubReaders(evidence: ViteBuildEvidence): ClientModule[] {
  const modules: ClientModule[] = [];
  for (const environment of evidence.environments) {
    // A chunk without a resolved consumer could run anywhere, so it proves nothing.
    if (environment.consumer !== "client") continue;
    const readers = new Map<string, ClientModule>();
    for (const read of environment.browserStubReads) {
      const { id, chunk } = read;
      const file = buildModuleFile(evidence, id);
      // A query id is a transformed variant, such as a Vue SFC block or a framework stub.
      if (!file || id.includes("?")) continue;
      if (!environment.chunks.some((item) => item.fileName === chunk && item.modules.includes(id)))
        continue;
      let module = readers.get(id);
      if (!module) readers.set(id, (module = { file, id, environment, reads: [] }));
      module.reads.push(read);
    }
    modules.push(...readers.values());
  }
  return modules;
}

/** The shortest importer path from an entry module of the environment to `id`, entry first. */
function importChain(environment: ViteBuildEnvironment, id: string): string[] | undefined {
  const entries = new Set(environment.entries);
  const via = new Map<string, string>();
  const seen = new Set([id]);
  let frontier = [id];
  while (frontier.length) {
    const next: string[] = [];
    for (const current of frontier) {
      if (entries.has(current)) {
        const chain = [current];
        for (let at = current; at !== id;) {
          at = via.get(at)!;
          chain.push(at);
        }
        return chain;
      }
      for (const importer of environment.importers[current] ?? []) {
        if (seen.has(importer)) continue;
        seen.add(importer);
        via.set(importer, current);
        next.push(importer);
      }
    }
    frontier = next;
  }
  return undefined;
}

function chainLocations(
  evidence: ViteBuildEvidence,
  graph: ImportGraph,
  chain: string[],
  path: (file: string) => string,
) {
  const locations: Array<{ file: string; range?: ImportGraphEdge["range"]; message: string }> = [];
  for (let index = 0; index < chain.length - 1; index++) {
    const from = buildModuleFile(evidence, chain[index]!);
    const to = buildModuleFile(evidence, chain[index + 1]!);
    if (!from || !to) continue;
    const edge = graph.importsOf(from).find((item) => item.to === to);
    locations.push({
      file: from,
      ...(edge?.range ? { range: edge.range } : {}),
      message: edge
        ? `imports '${edge.specifier}' → ${path(to)}`
        : `imports ${path(to)} in Vite's module graph`,
    });
  }
  return locations;
}

function displayId(
  evidence: ViteBuildEvidence,
  id: string,
  path: (file: string) => string,
): string {
  const file = buildModuleFile(evidence, id);
  return file ? path(file) : id.replace(/^\0/, "");
}
