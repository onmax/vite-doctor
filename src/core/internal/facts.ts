import { readFileSync } from "node:fs";
import { relative } from "pathe";
import type {
  DoctorHelpers,
  DynamicImportFact,
  ExportFact,
  FileFacts,
  ImportFact,
  SourceFileHandle,
  TemplateFact,
  TemplateRootNode,
} from "../primitives.js";
import { parseSfcFile, parseVueScriptsResult } from "./sfc.js";
import { parseScriptResult } from "./script.js";
import { TemplateNodeType, walkTemplate } from "./template.js";
import type { ScanFileEntry } from "./source-inventory.js";
import { markSession, type ScanSession } from "./scan-session.js";
import { nativeMatch, sha256 } from "./utils.js";
import { getNodeVisitorKeys } from "./visitor-keys.js";
import type { EvidenceGap } from "./cache-store.js";
import { isCachedFileFacts } from "./cached-file-facts.js";
import { projectWorkspacePackages } from "./applicability.js";
import { workspaceProjectView } from "./workspace-nuxt.js";
import { owningWorkspacePackage } from "./workspace-packages.js";

interface ParsedSource {
  sfc: SourceFileHandle["sfc"];
  scriptAst: Record<string, unknown> | null;
  templateAst: TemplateRootNode | null;
  gaps: EvidenceGap[];
}

interface SourceState {
  session: ScanSession;
  entry: ScanFileEntry;
  text?: string;
  parsed?: ParsedSource;
  facts?: FileFacts;
  cachedFacts?: () => Omit<FileFacts, "fileId"> | undefined;
  /** Undefined until a file that a changed-files run deferred is parsed. */
  shape?: number;
  fileId: number;
}

const sourceStates = new WeakMap<SourceFileHandle, SourceState>();

export async function parseSourceFiles(session: ScanSession): Promise<void> {
  const started = performance.now();
  let fileId = 0;
  for (const file of session.files) {
    const handle = await prepareSourceFile(session, file, fileId++);
    session.handles.push(handle);
    session.handlesByPath.set(handle.path, handle);
  }
  markSession(session, "parse", started);
}

/**
 * A file whose content a previous run analyzed reuses its cached shape, parser evidence, and
 * File Facts; its text and ASTs load only if a Rule has to run on it again.
 */
async function prepareSourceFile(
  session: ScanSession,
  file: ScanFileEntry,
  fileId: number,
): Promise<SourceFileHandle> {
  const absolute = file.path;
  const content = session.cache.fileHash(absolute) ?? {
    text: readFileSync(absolute, "utf8"),
    hash: "",
  };
  content.hash ||= sha256(content.text!);
  const cached = session.cache.file(absolute, content.hash, entryKey(file));
  if (cached) {
    addEvidenceGaps(session, cached.gaps);
    return createSourceHandle(session, file, content.hash, {
      session,
      entry: file,
      text: content.text,
      shape: cached.shape,
      cachedFacts: () => cached.facts(),
      fileId,
    });
  }
  // A changed-files run reports nothing from an unchanged file, so it parses one only when a
  // project-scoped Rule or an analysis needs it; its parser evidence would not be reported.
  if (session.gitChanges && !file.reportEligibility)
    return createSourceHandle(session, file, content.hash, {
      session,
      entry: file,
      text: content.text,
      fileId,
    });
  const text = content.text ?? readFileSync(absolute, "utf8");
  const parsed = await parseSource(file, text, content.hash);
  addEvidenceGaps(session, parsed.gaps);
  const state: SourceState = {
    session,
    entry: file,
    text,
    parsed,
    shape: shapeOf(parsed),
    fileId,
  };
  const handle = createSourceHandle(session, file, content.hash, state);
  state.facts = createFileFacts(session, file, fileId, text, content.hash, parsed);
  session.cache.recordFile(
    absolute,
    content.hash,
    entryKey(file),
    state.shape!,
    parsed.gaps,
    state.facts,
  );
  return handle;
}

function entryKey(file: ScanFileEntry): string {
  return JSON.stringify([file.displayPath, file.sourceKind, file.moduleName ?? null]);
}

/** Loads the ASTs of a file prepared from the cache. Its parser evidence was already reported. */
export async function loadSourceFile(handle: SourceFileHandle): Promise<void> {
  const state = sourceStates.get(handle);
  if (!state || state.parsed) return;
  state.parsed = await parseSource(state.entry, handle.text, handle.hash);
  if (state.shape !== undefined) return;
  state.shape = shapeOf(state.parsed);
  state.facts = createFileFacts(
    state.session,
    state.entry,
    state.fileId,
    handle.text,
    handle.hash,
    state.parsed,
  );
  state.session.cache.recordFile(
    handle.path,
    handle.hash,
    entryKey(state.entry),
    state.shape,
    state.parsed.gaps,
    state.facts,
  );
}

/**
 * Bit 1: SFC, bit 2: script AST, bit 4: template AST, known without parsing cached files.
 * Undefined for a file a changed-files run has not parsed yet.
 */
export function sourceShape(handle: SourceFileHandle): number | undefined {
  const state = sourceStates.get(handle);
  return state ? state.shape : 0;
}

/** File Facts for every source file, computing the ones the cache could not provide. */
export async function sourceFacts(session: ScanSession): Promise<FileFacts[]> {
  const facts: FileFacts[] = [];
  for (const handle of session.handles) {
    const state = sourceStates.get(handle)!;
    if (!handle.facts) await loadSourceFile(handle);
    if (!handle.facts) {
      state.facts = createFileFacts(
        session,
        state.entry,
        state.fileId,
        handle.text,
        handle.hash,
        state.parsed!,
      );
      session.cache.recordFile(
        handle.path,
        handle.hash,
        entryKey(state.entry),
        state.shape ?? 0,
        state.parsed!.gaps,
        state.facts,
      );
    }
    facts.push(handle.facts!);
  }
  return facts;
}

function reusableFacts(facts: unknown, file: ScanFileEntry, hash: string): facts is FileFacts {
  return (
    isCachedFileFacts(facts) &&
    facts.fileHash === hash &&
    facts.path === file.path &&
    facts.relativePath === file.displayPath &&
    facts.sourceKind === file.sourceKind &&
    facts.moduleName === file.moduleName
  );
}

function createSourceHandle(
  session: ScanSession,
  file: ScanFileEntry,
  hash: string,
  state: SourceState,
): SourceFileHandle {
  const absolute = file.path;
  const parsed = () => {
    if (!state.parsed) throw new Error(`Doctor read ${file.displayPath} before parsing it.`);
    return state.parsed;
  };
  const project = session.project.workspaceNuxt
    ? workspaceProjectView(
        session.project,
        owningWorkspacePackage(projectWorkspacePackages(session.project), file.displayPath),
      )
    : session.project;
  const handle: SourceFileHandle = {
    path: absolute,
    relativePath: file.displayPath,
    sourceKind: file.sourceKind,
    moduleName: file.moduleName,
    get text() {
      return (state.text ??= readFileSync(absolute, "utf8"));
    },
    hash,
    isVueSfc: absolute.endsWith(".vue"),
    get scriptAst() {
      return parsed().scriptAst;
    },
    get templateAst() {
      return parsed().templateAst;
    },
    get sfc() {
      return parsed().sfc;
    },
    get facts() {
      if (state.facts) return state.facts;
      const cached = state.cachedFacts?.();
      const facts = cached && { ...cached, fileId: state.fileId };
      if (!facts || !reusableFacts(facts, file, hash)) return undefined;
      return (state.facts = facts);
    },
    project,
    matches(this: SourceFileHandle, pattern) {
      return nativeMatch(this.relativePath, pattern);
    },
    inAppDir(this: SourceFileHandle, dir) {
      const appDir = project.nuxt?.appDir ? relative(session.root, project.nuxt.appDir) : "app";
      return this.relativePath.startsWith(`${appDir}/${dir}/`);
    },
    isModuleSource(this: SourceFileHandle) {
      return this.sourceKind === "module";
    },
  };
  sourceStates.set(handle, state);
  return handle;
}

async function parseSource(file: ScanFileEntry, text: string, hash: string): Promise<ParsedSource> {
  const absolute = file.path;
  const gaps: EvidenceGap[] = [];
  const isVueSfc = absolute.endsWith(".vue");
  const sfc = isVueSfc ? await parseOptionalSfc(absolute, text, hash) : undefined;
  if (sfc?.errors.length) {
    gaps.push({
      source: "vue-sfc-parser",
      message: `Cannot fully parse ${file.displayPath}: ${sfc.errors.join("; ")}. Check the component syntax and parser support, then rerun Doctor.`,
      files: [absolute],
    });
  }
  const parsedScript = isVueSfc
    ? parseVueScriptsResult(absolute, sfc?.descriptor, text)
    : text.trim()
      ? parseScriptResult(absolute, text)
      : undefined;
  if (
    parsedScript?.errors.length &&
    parsedScript.incomplete &&
    (isVueSfc || ["js", "jsx", "ts", "tsx"].includes(detectLang(absolute)))
  ) {
    gaps.push({
      source: "script-parser",
      message: `Cannot parse ${file.displayPath}: ${parsedScript.errors.join("; ")}. Check the source syntax and parser support, then rerun Doctor.`,
      files: [absolute],
    });
  }
  const templateAst = sfc?.getTemplateAst() ?? null;
  return { sfc, scriptAst: parsedScript?.ast ?? null, templateAst, gaps };
}

function shapeOf(parsed: ParsedSource): number {
  return (parsed.sfc ? 1 : 0) | (parsed.scriptAst ? 2 : 0) | (parsed.templateAst ? 4 : 0);
}

function addEvidenceGaps(session: ScanSession, gaps: readonly EvidenceGap[]): void {
  if (gaps.length)
    session.project.evidenceGaps = [...(session.project.evidenceGaps ?? []), ...gaps];
}

async function parseOptionalSfc(
  absolute: string,
  text: string,
  hash: string,
): Promise<Awaited<ReturnType<typeof parseSfcFile>> | undefined> {
  try {
    return await parseSfcFile(absolute, text, hash);
  } catch (error) {
    if (isModuleNotFound(error)) return undefined;
    throw error;
  }
}

function isModuleNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === "ERR_MODULE_NOT_FOUND"
  );
}

function createFileFacts(
  session: ScanSession,
  file: ScanFileEntry,
  fileId: number,
  text: string,
  hash: string,
  { scriptAst, templateAst, sfc }: ParsedSource,
): FileFacts {
  const imports: ImportFact[] = [];
  const exports: ExportFact[] = [];
  const dynamicImports: DynamicImportFact[] = [];
  const calls: Array<{ name: string; range?: ReturnType<DoctorHelpers["rangeFromOffsets"]> }> = [];
  const macros: Array<{ name: string; range?: ReturnType<DoctorHelpers["rangeFromOffsets"]> }> = [];
  const templateRefs: TemplateFact[] = [];

  if (scriptAst) {
    walkAstFacts(scriptAst, (node: any) => {
      if (node.type === "ImportDeclaration") {
        imports.push({
          source: String(node.source?.value ?? ""),
          specifiers: (node.specifiers ?? []).map((specifier: any) =>
            String(specifier.local?.name ?? specifier.imported?.name ?? "default"),
          ),
          kind: node.importKind === "type" ? "type" : "value",
          range: nodeRange(session, file.path, text, node),
        });
      } else if (node.type === "ExportNamedDeclaration") {
        const source = node.source?.value ? String(node.source.value) : undefined;
        for (const specifier of node.specifiers ?? []) {
          exports.push({
            name: String(specifier.exported?.name ?? specifier.local?.name ?? "unknown"),
            localName: specifier.local?.name,
            source,
            kind: node.exportKind === "type" ? "type" : "value",
            range: nodeRange(session, file.path, text, specifier),
          });
        }
        if (node.declaration)
          collectDeclarationExports(session, file.path, text, node.declaration, exports);
      } else if (node.type === "ExportDefaultDeclaration") {
        exports.push({
          name: "default",
          kind: "value",
          range: nodeRange(session, file.path, text, node),
        });
      } else if (node.type === "ExportAllDeclaration") {
        exports.push({
          name: "*",
          kind: node.exportKind === "type" ? "type" : "value",
          source: String(node.source?.value ?? ""),
          range: nodeRange(session, file.path, text, node),
        });
      } else if (node.type === "ImportExpression") {
        dynamicImports.push({
          source: typeof node.source?.value === "string" ? node.source.value : null,
          range: nodeRange(session, file.path, text, node),
        });
      } else if (node.type === "CallExpression") {
        const name = session.helpers.getCalleeName(node);
        if (name) {
          const fact = { name, range: nodeRange(session, file.path, text, node) };
          calls.push(fact);
          if (
            /^(defineProps|defineEmits|defineModel|defineExpose|defineOptions|withDefaults)$/.test(
              name,
            )
          )
            macros.push(fact);
        }
        if (name === "import") {
          dynamicImports.push({
            source: typeof node.arguments?.[0]?.value === "string" ? node.arguments[0].value : null,
            range: nodeRange(session, file.path, text, node),
          });
        }
      }
    });
  }

  if (templateAst) {
    walkTemplate(templateAst, (node) => {
      if (node.type !== TemplateNodeType.ATTRIBUTE) return;
      if (node.name !== "ref" && node.name !== "key") return;
      templateRefs.push({
        name: node.name,
        value: node.value?.content,
        range: session.helpers.rangeFromOffsets(
          file.path,
          text,
          node.loc.start.offset,
          node.loc.end.offset,
        ),
      });
    });
  }

  return {
    fileId,
    path: file.path,
    relativePath: file.displayPath,
    sourceKind: file.sourceKind,
    moduleName: file.moduleName,
    lang: detectLang(file.path),
    fileHash: hash,
    sfc: sfc?.blockHashes,
    imports,
    exports,
    dynamicImports,
    calls,
    templateRefs,
    macros,
    diagnosticsHints: [],
  };
}

function collectDeclarationExports(
  session: ScanSession,
  file: string,
  text: string,
  node: any,
  exports: ExportFact[],
) {
  if (!node || typeof node !== "object") return;
  if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
    if (node.id?.name)
      exports.push({
        name: node.id.name,
        localName: node.id.name,
        kind: "value",
        range: nodeRange(session, file, text, node),
      });
  } else if (node.type === "VariableDeclaration") {
    for (const declaration of node.declarations ?? []) {
      if (declaration.id?.name)
        exports.push({
          name: declaration.id.name,
          localName: declaration.id.name,
          kind: node.kind === "type" ? "type" : "value",
          range: nodeRange(session, file, text, declaration),
        });
    }
  } else if (node.type === "TSTypeAliasDeclaration" || node.type === "TSInterfaceDeclaration") {
    if (node.id?.name)
      exports.push({
        name: node.id.name,
        localName: node.id.name,
        kind: "type",
        range: nodeRange(session, file, text, node),
      });
  }
}

export function walkAstFacts(node: unknown, visit: (node: unknown) => void) {
  if (!node || typeof node !== "object") return;
  const typed = node as { type?: string };
  if (!typed.type) return;
  visit(typed);
  for (const key of getNodeVisitorKeys(typed as Record<string, unknown>)) {
    const value = (typed as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) walkAstFacts(child, visit);
    } else if (value && typeof value === "object") {
      walkAstFacts(value, visit);
    }
  }
}

function nodeRange(session: ScanSession, file: string, source: string, node: any) {
  const start = node?.start ?? node?.range?.[0];
  const end = node?.end ?? node?.range?.[1] ?? start;
  return typeof start === "number"
    ? session.helpers.rangeFromOffsets(file, source, start, end)
    : undefined;
}

function detectLang(file: string): FileFacts["lang"] {
  if (file.endsWith(".vue")) return "vue";
  if (file.endsWith(".tsx")) return "tsx";
  if (file.endsWith(".jsx")) return "jsx";
  if (file.endsWith(".ts") || file.endsWith(".mts") || file.endsWith(".cts")) return "ts";
  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) return "js";
  if (file.endsWith(".mdc")) return "mdc";
  if (file.endsWith(".md")) return "md";
  return "unknown";
}
