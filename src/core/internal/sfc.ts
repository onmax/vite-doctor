import { createHash } from "node:crypto";
import type { SfcBlockHashes, SfcHandle, SourceRange } from "../primitives.js";
import { lineColumnAt } from "./line-index.js";
import { parseScriptResult, type ScriptParseLang } from "./script.js";
import { SFC_TEMPLATE_PARSE_OPTIONS, templateAstFromDescriptor } from "./template.js";

const optionalImport = <T>(specifier: string) => import(/* @vite-ignore */ specifier) as Promise<T>;

export async function parseSfcFile(
  file: string,
  source: string,
  hash = sha256(source),
): Promise<SfcHandle & { errors: string[] }> {
  const { parse } = await optionalImport<typeof import("@vue/compiler-sfc")>("@vue/compiler-sfc");
  const { descriptor, errors } = parse(source, {
    filename: file,
    sourceMap: false,
    templateParseOptions: SFC_TEMPLATE_PARSE_OPTIONS,
  });
  const blockHashes: SfcBlockHashes = {
    template: descriptor.template ? sha256(descriptor.template.content) : undefined,
    script: descriptor.script ? sha256(descriptor.script.content) : undefined,
    scriptSetup: descriptor.scriptSetup ? sha256(descriptor.scriptSetup.content) : undefined,
    styles: descriptor.styles.map((style) => sha256(style.content)),
    custom: descriptor.customBlocks.map((block) => sha256(block.content)),
  };
  return {
    file,
    source,
    hash,
    descriptor,
    errors: errors.map((error) => (typeof error === "string" ? error : error.message)),
    blockHashes,
    getTemplateAst() {
      return templateAstFromDescriptor(descriptor);
    },
    getScriptAst() {
      return parseVueScripts(file, descriptor, source);
    },
    offsetToPosition(offset) {
      return rangeFromOffset(source, offset);
    },
    blockOffsetToFileOffset(block, offset) {
      const target =
        block === "template"
          ? descriptor.template
          : block === "script"
            ? descriptor.script
            : descriptor.scriptSetup;
      return (target?.loc.start.offset ?? 0) + offset;
    },
  };
}

export function createVueScriptForParsing(
  descriptor: any,
  source: string,
): { text: string; lang: ScriptParseLang } {
  const blocks = [descriptor?.script, descriptor?.scriptSetup]
    .filter(Boolean)
    .sort((left, right) => (left.loc?.start?.offset ?? 0) - (right.loc?.start?.offset ?? 0));
  const text: string[] = source
    .split("")
    .map((char) => (char === "\n" || char === "\r" ? char : " "));
  for (const block of blocks) {
    const start = block.loc?.start?.offset;
    if (typeof start !== "number" || !block.content) continue;
    for (let index = 0; index < block.content.length; index++) {
      text[start + index] = block.content[index]!;
    }
  }
  return { text: text.join(""), lang: vueScriptLang(blocks) };
}

export function parseVueScripts(
  file: string,
  descriptor: any,
  source: string,
): Record<string, unknown> | null {
  return parseVueScriptsResult(file, descriptor, source).ast;
}

export function parseVueScriptsResult(
  file: string,
  descriptor: any,
  source: string,
): { ast: Record<string, unknown> | null; errors: string[]; incomplete: boolean } {
  const blocks = [descriptor?.script, descriptor?.scriptSetup]
    .filter(Boolean)
    .sort((left, right) => (left.loc?.start?.offset ?? 0) - (right.loc?.start?.offset ?? 0));
  const lang = vueScriptLang(blocks);
  let program: Record<string, unknown> | null = null;
  const errors: string[] = [];
  let incomplete = false;
  for (const block of blocks) {
    const script = createVueScriptForParsing({ script: block }, source);
    if (!script.text.trim()) continue;
    const parsed = parseScriptResult(file, script.text.slice(0, block.loc.end.offset), lang);
    errors.push(...parsed.errors);
    incomplete ||= parsed.incomplete;
    const ast = parsed.ast;
    if (!ast) continue;
    if (!program) program = ast;
    else {
      (program.body as unknown[]).push(...(ast.body as unknown[]));
      (program.comments as unknown[]).push(...(ast.comments as unknown[]));
    }
  }
  if (program) program.end = source.length;
  return { ast: program, errors, incomplete };
}

function vueScriptLang(blocks: any[]): ScriptParseLang {
  const langs = blocks.map((block) => String(block.lang ?? "js").toLowerCase());
  if (langs.includes("tsx")) return "tsx";
  if (langs.includes("jsx")) return "jsx";
  if (langs.includes("ts")) return "ts";
  return "js";
}

function rangeFromOffset(source: string, offset: number): SourceRange {
  return { start: offset, end: offset, ...lineColumnAt(source, offset) };
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
