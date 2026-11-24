import { isAbsolute, resolve } from "pathe";
import type {
  ComponentNode,
  ComponentUsageEdge,
  ComponentUsageFact,
  ComponentUsageGraph,
  FileFacts,
  ImportFact,
  NuxtProjectInfo,
} from "../primitives.js";
import { pascalCase, tagCandidates } from "./component-facts.js";
import { sourceFacts } from "./facts.js";
import type { ScanSession } from "./scan-session.js";
import { createGraphIndex, type GraphIndex } from "./workspace-graph.js";

const graphs = new WeakMap<ScanSession, Promise<ComponentUsageGraph>>();

/** The run's component usage graph, built once from File Facts. */
export function componentUsageGraph(session: ScanSession): Promise<ComponentUsageGraph> {
  let graph = graphs.get(session);
  if (!graph) {
    graph = buildComponentUsageGraph(session);
    graphs.set(session, graph);
  }
  return graph;
}

async function buildComponentUsageGraph(session: ScanSession): Promise<ComponentUsageGraph> {
  session.facts = await sourceFacts(session);
  const facts = session.facts;
  const index = createGraphIndex(session, session.ruleInputs.frame().fs);
  const byId = new Map(facts.map((fact) => [fact.fileId, fact]));
  const components = new Map<string, ComponentNode>();
  for (const fact of facts) {
    if (!fact.component) continue;
    components.set(fact.path, {
      file: fact.path,
      relativePath: fact.relativePath,
      sourceKind: fact.sourceKind,
      facts: fact.component,
      renders: [],
      callers: [],
      indirectImporters: [],
    });
  }
  const resolveSfc = (from: FileFacts, source: string, imported: string) =>
    resolveImportedSfc(index, byId, from, source, imported);
  const unresolved: ComponentUsageEdge[] = [];
  for (const fact of facts) {
    const node: ComponentNode | undefined = components.get(fact.path);
    if (!node) continue;
    const nuxt = session.handlesByPath.get(fact.path)?.project.nuxt;
    const registry = nuxt?.components;
    const transformExclude = nuxt?.componentTransformExclude;
    const excludedFromComponentTransform = transformExclude?.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(fact.path);
    });
    const findBinding = (tag: string) => {
      const candidates = tagCandidates(tag);
      return node.facts.imports.find((item) => candidates.includes(item.local));
    };
    const inClientOnlySlot = (wrappers: ComponentUsageFact["wrappers"]) =>
      wrappers.some(({ tag, defaultSlot, shadowed }) => {
        if (!defaultSlot || shadowed) return false;
        const binding = findBinding(tag);
        const name = binding?.source === "#components" ? binding.imported : pascalCase(tag);
        if (
          binding?.source === "vue-client-only" ||
          binding?.source === "#app/components/client-only"
        )
          return true;
        if (!nuxt || name !== "ClientOnly" || (binding && binding.source !== "#components"))
          return false;
        if (!binding && excludedFromComponentTransform) return false;
        const registered = registry?.get(name);
        const locallyRegistered = node.facts.localComponents?.some((localName) =>
          tagCandidates(tag).includes(localName),
        );
        if (!binding && locallyRegistered && excludedFromComponentTransform !== false) return false;
        if (registered)
          return /(?:^|\/)nuxt\/dist\/app\/components\/client-only(?:\.[^/]+)?$/.test(
            registered.file,
          );
        return !!binding || !locallyRegistered;
      });
    for (const render of node.facts.dynamicRenders) {
      const clientOnly = inClientOnlySlot(render.wrappers);
      const binding: ComponentNode["facts"]["imports"][number] | undefined =
        node.facts.imports.find((item) => item.local === render.binding);
      const entry: { file: string; mode?: ComponentUsageEdge["nuxtMode"] } | undefined =
        binding?.source === "#components"
          ? (registry?.get(binding.imported) ??
            registry?.get(binding.imported.replace(/^Lazy(?=[A-Z])/, "")))
          : render.name === undefined
            ? undefined
            : resolveRuntimeComponent(node.facts, registry, render.name);
      const target: string | undefined = entry?.file
        ? resolve(session.root, entry.file)
        : binding && resolveSfc(fact, binding.source, binding.imported);
      const callee: ComponentNode | undefined = target ? components.get(target) : undefined;
      if (target && callee) {
        (node.dynamicRenders ??= []).push({
          target,
          ...(clientOnly && { clientOnlySlot: true }),
          ...(entry?.mode && { nuxtMode: entry.mode }),
        });
        if (callee !== node && !callee.indirectImporters.includes(fact.path))
          callee.indirectImporters.push(fact.path);
      } else if (!clientOnly && render.name === undefined) node.hasUnresolvedDynamicRender = true;
    }
    for (const usage of node.facts.usages) {
      const edge: ComponentUsageEdge = { from: fact.path, usage };
      if (inClientOnlySlot(usage.wrappers)) edge.clientOnlySlot = true;
      const binding = usage.tag.includes(".") ? undefined : findBinding(usage.tag);
      if (binding && binding.source !== "#components") {
        const target = resolveSfc(fact, binding.source, binding.imported);
        if (target) Object.assign(edge, { target, resolvedBy: "import" });
      } else {
        const name = (binding?.imported ?? pascalCase(usage.tag)).replace(/^Lazy(?=[A-Z])/, "");
        const entry = registry?.get(name);
        if (typeof entry?.file === "string") {
          const target = isAbsolute(entry.file) ? entry.file : resolve(session.root, entry.file);
          Object.assign(edge, { target, resolvedBy: "nuxt-components", nuxtMode: entry.mode });
        } else if (
          nuxt &&
          !usage.tag.includes(".") &&
          !tagCandidates(usage.tag).some(
            (tag) => usage.scope.includes(tag) || node.facts.localComponents?.includes(tag),
          )
        ) {
          edge.unresolvedNuxtName = name;
        }
      }
      node.renders.push(edge);
      const callee = edge.target ? components.get(edge.target) : undefined;
      if (callee) callee.callers.push(edge);
      else {
        delete edge.target;
        delete edge.resolvedBy;
        delete edge.nuxtMode;
        unresolved.push(edge);
      }
    }
  }
  for (const fact of facts) {
    for (const target of indirectSfcImports(fact, resolveSfc)) {
      const node = components.get(target);
      if (!node) continue;
      node.hasUntrackedImporter = true;
      if (!node.indirectImporters.includes(fact.path)) node.indirectImporters.push(fact.path);
    }
  }
  return { components, unresolved };
}

function resolveRuntimeComponent(
  facts: ComponentNode["facts"],
  registry: NuxtProjectInfo["components"] | undefined,
  name: string,
) {
  const candidates = tagCandidates(name);
  if (
    !facts.localComponentLookupKnown ||
    candidates.some(
      (candidate) =>
        candidate === facts.runtimeComponentName || facts.localComponents?.includes(candidate),
    )
  )
    return undefined;
  for (const candidate of candidates) {
    const exact = registry?.get(candidate);
    const base = candidate.startsWith("Lazy") ? registry?.get(candidate.slice(4)) : undefined;
    const global = exact?.global && exact.name === candidate ? exact : undefined;
    const lazy = base?.global && `Lazy${base.name}` === candidate ? base : undefined;
    if (global && lazy) return undefined;
    if (global || lazy) return global ?? lazy;
  }
  return undefined;
}

function resolveImportedSfc(
  index: GraphIndex,
  byId: Map<number, FileFacts>,
  from: FileFacts,
  source: string,
  imported: string,
): string | undefined {
  const target = byIdOf(byId, index.resolveImport(from, source));
  if (!target) return undefined;
  if (target.path.endsWith(".vue")) return imported === "default" ? target.path : undefined;
  if (imported === "default" || imported === "*") return undefined;
  const reexport = target.exports.find((item) => item.name === imported && item.source);
  if (!reexport?.source || (reexport.localName ?? reexport.name) !== "default") return undefined;
  const sfc = byIdOf(byId, index.resolveImport(target, reexport.source));
  return sfc?.path.endsWith(".vue") ? sfc.path : undefined;
}

function byIdOf(byId: Map<number, FileFacts>, id: number | undefined): FileFacts | undefined {
  return id === undefined ? undefined : byId.get(id);
}

/**
 * SFCs a file reaches other than through a `<script setup>` binding that its template only uses
 * as a tag, so their usages are not visible as component usage edges.
 */
function indirectSfcImports(
  fact: FileFacts,
  resolveSfc: (from: FileFacts, source: string, imported: string) => string | undefined,
): string[] {
  const targets: string[] = [];
  const add = (target: string | undefined) => {
    if (target && target !== fact.path) targets.push(target);
  };
  const setupImports = fact.component?.imports ?? [];
  const referenced = new Set(fact.component?.bindingReferences ?? []);
  for (const item of fact.imports) {
    if (item.kind === "type") continue;
    const setup = setupImports.filter((binding) => binding.source === item.source);
    if (setup.length && isSetupImport(item, setup)) {
      for (const binding of setup)
        if (referenced.has(binding.local)) add(resolveSfc(fact, binding.source, binding.imported));
      continue;
    }
    add(resolveSfc(fact, item.source, "default"));
    for (const specifier of item.specifiers) add(resolveSfc(fact, item.source, specifier));
  }
  for (const item of fact.exports) {
    if (!item.source || item.kind === "type") continue;
    add(resolveSfc(fact, item.source, item.localName ?? item.name));
    add(resolveSfc(fact, item.source, "default"));
  }
  for (const item of fact.dynamicImports)
    if (item.source !== null) add(resolveSfc(fact, item.source, "default"));
  return targets;
}

function isSetupImport(item: ImportFact, setup: Array<{ local: string }>): boolean {
  return item.specifiers.every((name) => setup.some((binding) => binding.local === name));
}
