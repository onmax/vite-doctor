import { createHash } from "node:crypto";
import type { SFCDescriptor } from "@vue/compiler-sfc";
import type { SfcBlockHashes, SfcHandle, SourceRange } from "../primitives.js";
import { lineColumnAt } from "./line-index.js";
import { parseScriptResult, type ScriptParseLang } from "./script.js";
import { SFC_TEMPLATE_PARSE_OPTIONS, templateAstFromDescriptor } from "./template.js";

const optionalImport = <T>(specifier: string) => import(/* @vite-ignore */ specifier) as Promise<T>;

const NUXT_CLIENT_ONLY_SSR_NAME = /^_component_(?:Lazy|lazy_)?(?:ClientOnly|client_only)$/;

/** Locate default slots Nuxt's server tree shaker can remove without a VNode fallback path. */
export async function nuxtPrunableDefaultSlots(file: string, source: string): Promise<Set<number>> {
  const offsets = new Set<number>();
  try {
    const { parse, compileScript, compileTemplate } =
      await optionalImport<typeof import("@vue/compiler-sfc")>("@vue/compiler-sfc");
    const { descriptor, errors: parseErrors } = parse(source, { filename: file, sourceMap: false });
    const template = descriptor.template;
    if (
      parseErrors.length ||
      !template ||
      template.src ||
      (template.lang && template.lang !== "html")
    )
      return offsets;
    const bindings =
      descriptor.script || descriptor.scriptSetup
        ? compileScript(descriptor, { id: file }).bindings
        : undefined;
    const { ast, errors } = compileTemplate({
      filename: file,
      source: template.content,
      id: file,
      ssr: true,
      ssrCssVars: descriptor.cssVars,
      compilerOptions: { bindingMetadata: bindings },
    });
    if (!ast || errors.length) return offsets;
    const templateOffset = template.loc.start.offset;
    visit(ast.children);

    function visit(nodes: NonNullable<typeof ast>["children"]) {
      for (const node of nodes) {
        if (node.type === 9) {
          for (const branch of node.branches) visit(branch.children);
        } else if (node.type === 11 || (node.type === 1 && node.tagType === 0)) {
          visit(node.children);
        } else if (node.type === 1 && node.tagType === 1 && node.ssrCodegenNode?.type === 14) {
          const call = node.ssrCodegenNode;
          const [component, , slots] = call.arguments;
          if (
            typeof call.callee === "symbol" &&
            call.callee.description === "ssrRenderComponent" &&
            typeof component === "string" &&
            NUXT_CLIENT_ONLY_SSR_NAME.test(component) &&
            typeof slots === "object" &&
            !Array.isArray(slots) &&
            slots.type === 15 &&
            slots.properties.some(
              (prop) => prop.key.type === 4 && prop.key.isStatic && prop.key.content === "default",
            )
          )
            offsets.add(templateOffset + node.loc.start.offset);
        }
      }
    }
  } catch {
    return new Set();
  }
  return offsets;
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
