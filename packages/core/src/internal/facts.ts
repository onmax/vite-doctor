import { readFileSync } from "node:fs";
import { relative } from "pathe";
import { visitorKeys } from "oxc-parser";
import type {
  DoctorHelpers,
  DynamicImportFact,
  ExportFact,
  FileFacts,
  ImportFact,
  SourceFileHandle,
  TemplateFact,
} from "../primitives.js";
import { createVueScriptForParsing, parseSfcFile } from "./sfc.js";
import { parseScript } from "./script.js";
import { parseTemplate } from "./template.js";
import type { ScanFileEntry } from "./source-inventory.js";
import { createCacheKey, markSession, type ScanSession } from "./scan-session.js";
import { nativeMatch, sha256 } from "./utils.js";

export async function parseSourceFiles(session: ScanSession): Promise<void> {
  const started = performance.now();
  let fileId = 0;
  for (const file of session.files) {
    const handle = await parseSourceFile(session, file, fileId++);
    session.handles.push(handle);
    if (handle.facts) session.facts.push(handle.facts);
  }
  markSession(session, "parse", started);
}

async function parseSourceFile(
  session: ScanSession,
  file: ScanFileEntry,
  fileId: number,
): Promise<SourceFileHandle> {
  const absolute = file.path;
  const text = readFileSync(absolute, "utf8");
  const hash = sha256(text);
  const cacheKey = createCacheKey(session, "fileFacts", `${absolute}:${hash}`);
  const cachedFacts = session.cache.get<FileFacts>(cacheKey);
  const isVueSfc = absolute.endsWith(".vue");
  const sfc = isVueSfc ? await parseOptionalSfc(absolute, text, hash) : undefined;
  const script = isVueSfc ? createVueScriptForParsing(sfc?.descriptor as any, text) : undefined;
  const scriptText = isVueSfc ? (script?.text ?? "") : text;
  const scriptAst = scriptText.trim() ? parseScript(absolute, scriptText, script?.lang) : null;
  const templateAst = isVueSfc && sfc ? await parseTemplate(absolute, text) : null;
  const facts =
    cachedFacts && cachedFacts.fileHash === hash
      ? { ...cachedFacts, fileId }
      : createFileFacts(session, file, fileId, text, hash, scriptAst, templateAst, sfc);
  session.cache.set(cacheKey, facts);
  return {
    path: absolute,
    relativePath: file.displayPath,
    sourceKind: file.sourceKind,
    moduleName: file.moduleName,
    text,
    hash,
    isVueSfc,
    scriptAst,
    templateAst,
    sfc,
    facts,
    project: session.project,
    matches(this: SourceFileHandle, pattern) {
      return nativeMatch(this.relativePath, pattern);
    },
    inAppDir(this: SourceFileHandle, dir) {
      const appDir = session.project.nuxt?.appDir
        ? relative(session.root, session.project.nuxt.appDir)
        : "app";
      return this.relativePath.startsWith(`${appDir}/${dir}/`);
    },
    isModuleSource(this: SourceFileHandle) {
      return this.sourceKind === "module";
    },
  };
}

async function parseOptionalSfc(
  absolute: string,
  text: string,
  hash: string,
): Promise<SourceFileHandle["sfc"]> {
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
  scriptAst: Record<string, unknown> | null,
  templateAst: Record<string, unknown> | null,
  sfc: SourceFileHandle["sfc"],
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
    walkTemplateFacts(templateAst, (node: any) => {
      if (node.type !== "VAttribute" && node.type !== "VDirective") return;
      const name = node.key?.name?.name ?? node.key?.name;
      if (name === "ref" || name === "key") {
        templateRefs.push({
          name,
          value: node.value?.value,
          range: nodeRange(session, file.path, text, node),
        });
      }
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
    complexity: computeComplexity(text, scriptAst),
    tokens: createTokenFacts(text),
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

function walkAstFacts(node: unknown, visit: (node: unknown) => void) {
  if (!node || typeof node !== "object") return;
  const typed = node as { type?: string };
  if (!typed.type) return;
  visit(typed);
  for (const key of visitorKeys[typed.type] ?? []) {
    const value = (typed as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) walkAstFacts(child, visit);
    } else if (value && typeof value === "object") {
      walkAstFacts(value, visit);
    }
  }
}

function walkTemplateFacts(node: unknown, visit: (node: unknown) => void) {
  if (!node || typeof node !== "object") return;
  const typed = node as { type?: string };
  if (!typed.type) return;
  visit(typed);
  for (const key of templateFactKeys(typed.type)) {
    const value = (typed as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) walkTemplateFacts(child, visit);
    } else if (value && typeof value === "object") {
      walkTemplateFacts(value, visit);
    }
  }
}

function templateFactKeys(type: string): string[] {
  if (visitorKeys[type]) return visitorKeys[type];
  switch (type) {
    case "Program":
      return ["body", "templateBody"];
    case "VDocumentFragment":
    case "VElement":
      return ["children", "startTag", "endTag"];
    case "VStartTag":
      return ["attributes"];
    case "VAttribute":
    case "VDirective":
      return ["key", "value"];
    case "VExpressionContainer":
      return ["expression", "references"];
    default:
      return [];
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

function computeComplexity(text: string, ast: Record<string, unknown> | null) {
  let cyclomatic = 1;
  let cognitive = 0;
  if (ast) {
    walkAstFacts(ast, (node: any) => {
      if (
        /^(IfStatement|ForStatement|ForInStatement|ForOfStatement|WhileStatement|DoWhileStatement|CatchClause|ConditionalExpression|LogicalExpression|SwitchCase)$/.test(
          node.type,
        )
      ) {
        cyclomatic++;
        cognitive++;
      }
    });
  }
  return { cyclomatic, cognitive, lines: text.split(/\r?\n/).length };
}

function createTokenFacts(text: string) {
  const normalizedTokens = (
    text.match(/[A-Za-z_$][\w$]*|\d+|=>|===|!==|==|!=|[{}()[\].,;:+\-*/%<>]/g) ?? []
  ).map((token) => (/^[A-Za-z_$]/.test(token) ? token : token.replace(/\d+/g, "0")));
  const hashes: string[] = [];
  const window = 30;
  for (let index = 0; index + window <= normalizedTokens.length; index += 10) {
    hashes.push(sha256(normalizedTokens.slice(index, index + window).join(" ")).slice(0, 16));
  }
  return { hashes, normalizedTokens };
}
