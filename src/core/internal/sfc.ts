import { createHash } from "node:crypto";
import type { SFCDescriptor } from "@vue/compiler-sfc";
import type { RuleFileSystem, SfcBlockHashes, SfcHandle, SourceRange } from "../primitives.js";
import { loadTypeScript, loadVueCompilerSfc } from "./lazy-parsers.js";
import { lineColumnAt } from "./line-index.js";
import { parseScriptResult, type ScriptParseLang } from "./script.js";
import { SFC_TEMPLATE_PARSE_OPTIONS, templateAstFromDescriptor } from "./template.js";

const optionalImport = <T>(specifier: string) => import(/* @vite-ignore */ specifier) as Promise<T>;

export const NUXT_CLIENT_ONLY_TAG = /^(?:Lazy|lazy-)?(?:ClientOnly|client-only)$/;
const NUXT_CLIENT_ONLY_SSR_NAME = /^_component_(?:Lazy|lazy_)?(?:ClientOnly|client_only)$/;

/** Classify emitted slot paths; missing offsets are unknown, not evidence that a slot survives. */
export function nuxtDefaultSlotSsr(
  file: string,
  source: string,
  fs: RuleFileSystem,
): Map<number, "pruned" | "retained"> {
  const slotsByOffset = new Map<number, "pruned" | "retained">();
  try {
    const { parse, compileScript, compileTemplate, registerTS, invalidateTypeCache } =
      loadVueCompilerSfc();
    const { descriptor, errors: parseErrors } = parse(source, { filename: file, sourceMap: false });
    const template = descriptor.template;
    if (
      parseErrors.length ||
      !template ||
      template.src ||
      (template.lang && template.lang !== "html")
    )
      return slotsByOffset;
    let bindings;
    if (descriptor.script || descriptor.scriptSetup) {
      registerTS(loadTypeScript);
      const typeFiles = new Set([file]);
      try {
        const compiled = compileScript(descriptor, {
          id: file,
          isProd: true,
          fs: {
            fileExists: (path) => fs.stat(path)?.isFile() ?? false,
            readFile: (path) => {
              typeFiles.add(path);
              return fs.readText(path);
            },
            realpath: (path) => fs.realpath(path) ?? path,
          },
        });
        bindings = compiled.bindings;
        for (const path of compiled.deps ?? []) typeFiles.add(path);
      } finally {
        for (const path of typeFiles) invalidateTypeCache(path);
      }
    }
    const { ast, errors } = compileTemplate({
      filename: file,
      source: template.content,
      id: file,
      ssr: true,
      isProd: true,
      ssrCssVars: descriptor.cssVars,
      compilerOptions: { bindingMetadata: bindings },
    });
    if (!ast?.codegenNode || errors.length) return slotsByOffset;
    const emitted = new Set<object>();
    const vnodeOffsets = new Set<number>();
    collectCodegen(ast.codegenNode);
    const templateOffset = template.loc.start.offset;
    visit(ast.children);

    function collectCodegen(value: unknown) {
      if (!value || typeof value !== "object" || emitted.has(value)) return;
      emitted.add(value);
      if (isLocatedVNode(value)) vnodeOffsets.add(value.loc.start.offset);
      for (const [key, child] of Object.entries(value)) if (key !== "loc") collectCodegen(child);
    }

    function visit(nodes: NonNullable<typeof ast>["children"]) {
      for (const node of nodes) {
        if (node.type === 9) {
          for (const branch of node.branches) visit(branch.children);
        } else if (node.type === 11) {
          visit(node.children);
        } else if (node.type === 1) {
          if (node.tagType === 1) {
            const offset = templateOffset + node.loc.start.offset;
            const call = node.ssrCodegenNode;
            if (vnodeOffsets.has(node.loc.start.offset)) {
              slotsByOffset.set(offset, "retained");
            } else if (call?.type === 14 && emitted.has(call) && typeof call.callee === "symbol") {
              const [component, , slots] = call.arguments;
              if (call.callee.description === "ssrRenderVNode") {
                slotsByOffset.set(offset, "retained");
              } else if (
                call.callee.description === "ssrRenderComponent" &&
                typeof component === "string"
              ) {
                const pruned =
                  NUXT_CLIENT_ONLY_SSR_NAME.test(component) &&
                  typeof slots === "object" &&
                  !Array.isArray(slots) &&
                  slots.type === 15 &&
                  slots.properties.some(
                    (prop) =>
                      prop.key.type === 4 && prop.key.isStatic && prop.key.content === "default",
                  );
                slotsByOffset.set(offset, pruned ? "pruned" : "retained");
              }
            }
          }
          visit(node.children);
        }
      }
    }
  } catch {
    return new Map();
  }
  return slotsByOffset;
}

function isLocatedVNode(value: object): value is { loc: { start: { offset: number } } } {
  const node = value as { type?: number; loc?: { source?: string; start?: { offset?: number } } };
  return node.type === 13 && !!node.loc?.source && typeof node.loc.start?.offset === "number";
}

export async function parseSfcFile(
  file: string,
  source: string,
  hash = sha256(source),
): Promise<SfcHandle & { descriptor: SFCDescriptor; errors: string[] }> {
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
    const parsed = parseScriptResult(file, script.text.slice(0, block.loc.end.offset), lang, {
      astType: "ts",
      range: true,
    });
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
