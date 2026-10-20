import { isAbsolute, resolve } from "pathe";
import type {
  ComponentNode,
  ComponentUsageEdge,
  ComponentUsageGraph,
  FileFacts,
  ImportFact,
} from "../primitives.js";
import { camelize } from "./component-facts.js";
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
    const node = fact.component && components.get(fact.path);
    if (!node) continue;
    const registry = nuxtComponentRegistry(session, fact.path);
    for (const usage of node.facts.usages) {
      const edge: ComponentUsageEdge = { from: fact.path, usage };
      const binding = usage.tag.includes(".")
        ? undefined
        : node.facts.imports.find((item) => tagCandidates(usage.tag).includes(item.local));
      if (binding) {
        const target = resolveSfc(fact, binding.source, binding.imported);
        if (target) Object.assign(edge, { target, resolvedBy: "import" });
      } else {
        const target = registry?.get(pascalCase(usage.tag).replace(/^Lazy(?=[A-Z])/, ""));
        if (target) Object.assign(edge, { target, resolvedBy: "nuxt-components" });
      }
      node.renders.push(edge);
      const callee = edge.target ? components.get(edge.target) : undefined;
      if (callee) callee.callers.push(edge);
      else {
        delete edge.target;
        delete edge.resolvedBy;
        unresolved.push(edge);
      }
    }
  }
  for (const fact of facts) {
    for (const target of indirectSfcImports(fact, resolveSfc)) {
      const node = components.get(target);
      if (node && !node.indirectImporters.includes(fact.path))
        node.indirectImporters.push(fact.path);
    }
  }
  return { components, unresolved };
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

/** Nuxt component registry entries the Project Inventory names with a file. */
function nuxtComponentRegistry(
  session: ScanSession,
  file: string,
): Map<string, string> | undefined {
  const nuxt = session.handlesByPath.get(file)?.project.nuxt ?? session.project.nuxt;
  if (!nuxt?.components?.size) return undefined;
  const registry = new Map<string, string>();
  for (const entry of nuxt.components.values()) {
    if (typeof entry?.name !== "string" || typeof entry.file !== "string") continue;
    registry.set(
      pascalCase(entry.name),
      isAbsolute(entry.file) ? entry.file : resolve(session.root, entry.file),
    );
  }
  return registry.size ? registry : undefined;
}

/** Names a `<script setup>` binding can have to render as `tag`, as Vue's compiler resolves them. */
function tagCandidates(tag: string): string[] {
  const camel = camelize(tag);
  return [tag, camel, camel.charAt(0).toUpperCase() + camel.slice(1)];
}

function pascalCase(tag: string): string {
  const camel = camelize(tag);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}
