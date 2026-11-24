import { isBuiltin } from "node:module";
import { decodedMappings, TraceMap } from "@jridgewell/trace-mapping";
import type { Node } from "oxc-parser";
import { dirname, isAbsolute, relative, resolve } from "pathe";
import type { Plugin } from "vite";
import { walkAstFacts } from "./core/internal/facts.js";
import { analyzeScript, scopeDialect } from "./core/internal/script-scope.js";
import type { ViteBuildEnvironment } from "./rule-packs/vite/rules/build-evidence.js";

type GenerateBundle = NonNullable<Plugin["generateBundle"]>;
type GenerateHook = Extract<GenerateBundle, (...args: never[]) => unknown>;
type Graph = ThisParameterType<GenerateHook>;
type Output = Parameters<GenerateHook>[0];
type Bundle = Parameters<GenerateHook>[1];
type Chunk = Extract<Bundle[string], { type: "chunk" }>;

const BROWSER_STUB = "__vite-browser-external";
type ImportUse = { specifier: string; start: number; dynamic: boolean };

function isBrowserStub(id: string) {
  return id === BROWSER_STUB || id.startsWith(`${BROWSER_STUB}:`);
}

export function collectBuildEnvironment(
  graph: Graph,
  output: Output,
  bundle: Bundle,
  root: string,
  name: string,
  privateMaps: boolean,
  resolutions: ReadonlyMap<string, string> | undefined,
) {
  const id = (file: string) => {
    if (!isAbsolute(file)) return file;
    const path = relative(root, file);
    return path.startsWith("../") || isAbsolute(path) ? file : path;
  };
  const environment: ViteBuildEnvironment = {
    name,
    consumer: "client",
    chunks: [],
    entries: [],
    importers: Object.create(null),
    browserStubReads: [],
  };
  const chunks = Object.values(bundle).filter((item) => item.type === "chunk");
  const stubChunks = new Map(
    chunks.flatMap((chunk) => {
      const stubs = chunk.moduleIds.filter(isBrowserStub);
      return stubs.length ? [[chunk.fileName, stubs] as const] : [];
    }),
  );
  const outputDir = output.dir ?? dirname(output.file ?? resolve(root, "dist/index.js"));
  let missingMaps = false;
  for (const chunk of chunks) {
    const map = chunk.map;
    const mapFile = chunk.sourcemapFileName ?? `${chunk.fileName}.map`;
    if (privateMaps) {
      if (chunk.sourcemapFileName) delete bundle[chunk.sourcemapFileName];
      chunk.sourcemapFileName = null;
      chunk.map = null;
    }
    environment.chunks.push({
      fileName: chunk.fileName,
      isEntry: chunk.isEntry,
      modules: chunk.moduleIds.map(id),
    });
    if (chunk.isEntry && chunk.facadeModuleId) environment.entries.push(id(chunk.facadeModuleId));
    const candidates = new Map<string, readonly string[]>();
    for (const moduleId of chunk.moduleIds) {
      const info = graph.getModuleInfo(moduleId);
      if (!info) continue;
      environment.importers[id(moduleId)] = [...info.importers, ...info.dynamicImporters].map(id);
      if (
        isAbsolute(moduleId) &&
        /\.[cm]?[jt]sx?$/.test(moduleId) &&
        [...info.importedIds, ...info.dynamicallyImportedIds].some(isBrowserStub)
      ) {
        candidates.set(moduleId, [...info.importedIds, ...info.dynamicallyImportedIds]);
      }
    }
    if (!candidates.size || !stubChunks.size || !resolutions?.size) continue;
    if (!map) {
      missingMaps ||= [...resolutions].some(([key, resolvedId]) => {
        return isBrowserStub(resolvedId) && candidates.has(key.slice(0, key.indexOf("\0")));
      });
      continue;
    }
    environment.browserStubReads.push(
      ...traceReads(
        chunk,
        map,
        resolve(outputDir, mapFile),
        candidates,
        stubChunks,
        id,
        resolutions,
      ),
    );
  }
  return { environment, missingMaps };
}

function traceReads(
  chunk: Chunk,
  map: NonNullable<Chunk["map"]>,
  mapFile: string,
  candidates: ReadonlyMap<string, readonly string[]>,
  stubChunks: Map<string, string[]>,
  id: (file: string) => string,
  resolutions: ReadonlyMap<string, string>,
) {
  if (map.version !== 3) return [];
  const trace = new TraceMap({ ...map, version: 3 });
  const sources = trace.sources.map((source, index) => {
    const file = resolve(dirname(mapFile), trace.sourceRoot ?? "", source ?? "");
    const text = trace.sourcesContent?.[index];
    if (!text || !candidates.has(file)) return;
    return { file, lines: lineStarts(text), uses: importUses(text, file) };
  });
  if (!sources.some((source) => source?.uses.size)) return [];
  const generated = analyzeScript(chunk.code, "jsx");
  if (!generated) return [];
  const reads = new Set(
    [...generated.references.values()]
      .filter((ref) => ref.isRead())
      .map((ref) => ref.identifier.range[0]),
  );
  const dynamic = new Map<number, string[]>();
  walkAstFacts(generated.ast, (node) => {
    const expression = node as Node;
    if (expression.type !== "ImportExpression") return;
    const source = importString(expression.source);
    if (!source?.startsWith(".")) return;
    const target = relative(".", resolve(dirname(chunk.fileName), source));
    const stubs = stubChunks.get(target);
    if (stubs && chunk.dynamicImports.includes(target)) dynamic.set(expression.start, stubs);
  });
  const lines = lineStarts(chunk.code);
  const traced = new Map<string, { file: string; use: ImportUse; stubs?: string[] }>();
  for (const [line, segments] of decodedMappings(trace).entries()) {
    for (const segment of segments) {
      if (segment.length === 1) continue;
      const [column, index, sourceLine, sourceColumn] = segment;
      const source = sources[index];
      if (!source) continue;
      const use = source.uses.get(source.lines[sourceLine] + sourceColumn);
      if (!use || !(use.dynamic ? dynamic : reads).has(lines[line] + column)) continue;
      traced.set(`${source.file}\0${use.start}`, {
        file: source.file,
        use,
        stubs: dynamic.get(lines[line] + column),
      });
    }
  }
  return [...traced.values()].flatMap(({ file, use, stubs }) => {
    const resolvedId = resolutions.get(`${file}\0${use.specifier}`);
    if (
      !resolvedId ||
      !isBrowserStub(resolvedId) ||
      !candidates.get(file)?.includes(resolvedId) ||
      (stubs && !stubs.includes(resolvedId))
    )
      return [];
    return [{ id: id(file), chunk: chunk.fileName, specifier: use.specifier, start: use.start }];
  });
}

function importUses(text: string, file: string): Map<number, ImportUse> {
  const uses = new Map<number, ImportUse>();
  const scope = analyzeScript(text, scopeDialect(file));
  if (!scope) return uses;
  for (const reference of scope.references.values()) {
    if (!reference.isRead() || !reference.isValueReference) continue;
    const definition = reference.resolved?.defs[0];
    if (definition?.type !== "ImportBinding" || definition.parent.type !== "ImportDeclaration")
      continue;
    const { source, range, importKind } = definition.parent;
    if (
      importKind === "type" ||
      (definition.node.type === "ImportSpecifier" && definition.node.importKind === "type")
    )
      continue;
    if (typeof source.value !== "string" || !isBuiltin(source.value)) continue;
    uses.set(reference.identifier.range[0], {
      specifier: source.value,
      start: range[0],
      dynamic: false,
    });
  }
  walkAstFacts(scope.ast, (node) => {
    const expression = node as Node;
    if (expression.type !== "ImportExpression") return;
    const specifier = importString(expression.source);
    if (specifier && isBuiltin(specifier))
      uses.set(expression.start, { specifier, start: expression.start, dynamic: true });
  });
  return uses;
}

function importString(node: Node): string | undefined {
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && !node.expressions.length)
    return node.quasis[0]?.value.cooked ?? undefined;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (const match of text.matchAll(/\r\n|[\n\r\u2028\u2029]/g))
    starts.push(match.index + match[0].length);
  return starts;
}
