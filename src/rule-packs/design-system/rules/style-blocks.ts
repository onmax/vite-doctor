import type { AnyNode, Declaration, Root } from "postcss";

export interface StyleColor {
  /** SFC offsets of the color literal. */
  start: number;
  end: number;
  text: string;
  property: string;
}

interface StyleBlock {
  content: string;
  lang?: string;
  scoped?: boolean;
  module?: boolean | string;
  src?: string;
  loc: { start: { offset: number } };
}

type Parse = (css: string) => Root;
type SelectorMode = "plain" | "scoped" | "module";

let postcssParse: Promise<Parse> | undefined;

const colorFunctions = new Set([
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "hwb",
  "lab",
  "lch",
  "oklab",
  "oklch",
  "color",
]);
// Their arguments are references, URLs, Vue bindings, or colors already paired per color scheme.
const opaqueFunctions = new Set([
  "url",
  "var",
  "v-bind",
  "env",
  "attr",
  "image-set",
  "src",
  "light-dark",
]);
// At-rules whose declarations define the theme or a custom property rather than use a color.
const definingAtRules = new Set(["theme", "property"]);
const groupingAtRules = new Set([
  "media",
  "supports",
  "container",
  "layer",
  "starting-style",
  "variant",
]);
const themeClass = /\.(?:dark|light)(?:-mode|-theme)?(?![\w\u0080-\uFFFF-])/;
const themeAttribute =
  /^\[\s*(?:data-(?:theme|mode|color-scheme|color-mode|bs-theme)|theme|color-scheme)\s*=\s*(?:"(?:dark|light)"|'(?:dark|light)'|dark|light)\s*\]$/i;
// A mask reads only the alpha of its colors, so they never reach the screen.
const maskProperty = /^(?:-webkit-)?mask(?:-|$)/i;
// Dynamic parts that make a color function depend on a variable or the current color.
const dynamicArgument = /var\(|v-bind\(|env\(|attr\(|[$@]|#\{|\bcurrentcolor\b/i;
// A relative color, such as `rgb(from currentColor r g b / 50%)`, follows its origin color.
const relativeColor = /^\s*from\s+/i;

/**
 * Hardcoded color literals in an SFC's `<style>` blocks: hex colors and color functions with
 * literal arguments in plain declarations. Custom property definitions, `@theme` and `@property`
 * blocks, rules scoped to a color scheme or theme, `light-dark()`, `v-bind()`, `var()` fallbacks,
 * strings, and URLs are not colors the block hardcodes.
 * Blocks with `src`, Sass indented syntax, or Stylus are skipped; blocks PostCSS cannot parse are
 * counted in `unparsed`.
 */
export async function styleBlockColors(
  descriptor: unknown,
): Promise<{ colors: StyleColor[]; unparsed: number }> {
  const blocks = ((descriptor as { styles?: StyleBlock[] } | undefined)?.styles ?? []).filter(
    (block) => !block.src && readableLang(block.lang) && /#|\(/.test(block.content),
  );
  const colors: StyleColor[] = [];
  let unparsed = 0;
  if (!blocks.length) return { colors, unparsed };
  const parse = await loadPostcss();
  for (const block of blocks) {
    const mode = block.scoped ? "scoped" : block.module ? "module" : "plain";
    const css = withoutLineComments(block.content, block.lang);
    let root: Root;
    try {
      root = parse(withoutInterpolation(css, block.lang));
    } catch {
      unparsed++;
      continue;
    }
    root.walkDecls((decl) => {
      if (/^(?:--|\$|@)/.test(decl.prop) || maskProperty.test(decl.prop)) return;
      if (insideDefiningAtRule(decl) || insideThemeScope(decl, mode, block.lang)) return;
      const start = valueOffset(decl);
      if (start === undefined) return;
      const value = decl.raws.value?.raw ?? decl.value;
      for (const literal of colorLiterals(value, css.slice(start, start + value.length)))
        colors.push({
          start: block.loc.start.offset + start + literal.start,
          end: block.loc.start.offset + start + literal.end,
          text: block.content.slice(start + literal.start, start + literal.end),
          property: decl.prop,
        });
    });
  }
  return { colors, unparsed };
}

function loadPostcss(): Promise<Parse> {
  postcssParse ??= import("postcss").then((postcss) => (css) => postcss.parse(css));
  return postcssParse;
}

function readableLang(lang: string | undefined): boolean {
  return lang === undefined || ["css", "pcss", "postcss", "scss", "less"].includes(lang);
}

// Keep offsets aligned with the original SFC while making the block readable by PostCSS.
function withoutLineComments(content: string, lang: string | undefined): string {
  if (lang !== "scss" && lang !== "less") return content;
  return content.replace(
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/)|(?<![^\s;{}])\/\/[^\r\n]*/g,
    (match, opaque: string | undefined) => opaque ?? " ".repeat(match.length),
  );
}

function withoutInterpolation(content: string, lang: string | undefined): string {
  if (lang !== "scss" && lang !== "less") return content;
  return content.replace(lang === "scss" ? /#\{[^{}]*\}/g : /@\{[^{}]*\}/g, (match) =>
    "_".repeat(match.length),
  );
}

function insideDefiningAtRule(node: AnyNode): boolean {
  for (let parent = node.parent as AnyNode | undefined; parent; parent = parent.parent as AnyNode)
    if (parent.type === "atrule" && definingAtRules.has(parent.name.toLowerCase())) return true;
  return false;
}

function insideThemeScope(node: AnyNode, mode: SelectorMode, lang: string | undefined): boolean {
  const preprocessed = lang === "scss" || lang === "less";
  let checkedSelector = false;
  for (let parent = node.parent as AnyNode | undefined; parent; parent = parent.parent as AnyNode) {
    if (parent.type === "rule" && !checkedSelector) {
      checkedSelector = true;
      if (isThemeSelector(parent.selector, mode)) return true;
    }
    if (parent.type !== "atrule") continue;
    const name = parent.name.toLowerCase();
    if (!groupingAtRules.has(name)) {
      checkedSelector = true;
      if (preprocessed && name !== "scope" && !/^(?:-\w+-)?keyframes$/.test(name)) return false;
    }
    if (name === "media" && isThemeMedia(parent.params)) return true;
    if (name === "variant" && /^(?:dark|light)$/.test(parent.params.trim())) return true;
  }
  return false;
}

function isThemeMedia(params: string): boolean {
  const query = params.replace(/\/\*[\s\S]*?\*\//g, " ").trim();
  if (query.includes("\\")) return false;
  const mediaType = /^(?:only\s+)?(?!not\b|and\b|or\b|only\b)[a-z][\w-]*\s+and\s*/i.exec(query);
  let start = mediaType?.[0].length ?? 0;
  let scoped = false;
  while (query[start] === "(") {
    const end = matchingParen(query, start);
    scoped ||= /^\(\s*prefers-color-scheme\s*:\s*(?:dark|light)\s*\)$/i.test(
      query.slice(start, end),
    );
    if (end === query.length) return scoped;
    const and = /^\s*and(?![\w-])\s*/i.exec(query.slice(end));
    if (!and) return false;
    start = end + and[0].length;
  }
  return false;
}

function isThemeSelector(selector: string, mode: SelectorMode): boolean {
  if (/\\|\/\*/.test(selector)) return false;
  const token = /\[(?:"[^"]*"|'[^']*'|[^\]"'])*\]|(?<!:)(?::global|::v-global)\(|[(),[\]"']/g;
  let scoped = false;
  let globalTheme: boolean | undefined;
  let start = 0;
  for (let match = token.exec(selector); match; match = token.exec(selector)) {
    scoped ||= themeClass.test(selector.slice(start, match.index));
    const text = match[0];
    if (text.endsWith("(")) {
      const open = token.lastIndex - 1;
      token.lastIndex = matchingParen(selector, open);
      if (mode === "scoped" && text !== "(")
        globalTheme ??= isThemeSelector(selector.slice(open + 1, token.lastIndex - 1), "plain");
      else if (mode === "module" && text === ":global(")
        scoped ||= isThemeSelector(selector.slice(open + 1, token.lastIndex - 1), "plain");
    } else if (themeAttribute.test(text)) scoped = true;
    else if (!text.startsWith("[") || text === "[") return false;
    start = token.lastIndex;
  }
  return globalTheme ?? (scoped || themeClass.test(selector.slice(start)));
}

function valueOffset(decl: Declaration): number | undefined {
  const start = decl.source?.start?.offset;
  if (start === undefined) return undefined;
  return start + decl.prop.length + (decl.raws.between ?? ":").length;
}

/** Color literals in one declaration value, with offsets into the value. */
function colorLiterals(value: string, source: string): Array<{ start: number; end: number }> {
  const found: Array<{ start: number; end: number }> = [];
  let index = 0;
  while (index < value.length) {
    const char = value[index]!;
    if (char === '"' || char === "'") {
      index = skipString(value, index);
      continue;
    }
    if (char === "/" && value[index + 1] === "*") {
      const close = value.indexOf("*/", index + 2);
      index = close === -1 ? value.length : close + 2;
      continue;
    }
    if (char === "#") {
      const hex = /^#([\da-f]+)(?![\w-])/i.exec(value.slice(index));
      const before = value[index - 1];
      if (hex && [3, 4, 6, 8].includes(hex[1]!.length) && !(before && /[\w-]/.test(before)))
        found.push({ start: index, end: index + hex[0].length });
      index += hex ? hex[0].length : 1;
      continue;
    }
    const name = /^[a-z][\w-]*(?=\()/i.exec(value.slice(index));
    if (name && !(index > 0 && /[\w-]/.test(value[index - 1]!))) {
      const open = index + name[0].length;
      const close = matchingParen(value, open);
      const lower = name[0].toLowerCase();
      if (opaqueFunctions.has(lower)) {
        index = close;
        continue;
      }
      const args = source.slice(open + 1, close - 1).replace(/\/\*[\s\S]*?\*\//g, " ");
      if (colorFunctions.has(lower)) {
        if (!dynamicArgument.test(args) && !relativeColor.test(args))
          found.push({ start: index, end: close });
        index = close;
        continue;
      }
      // A mix with a variable or the current color follows the theme.
      if (lower === "color-mix" && dynamicArgument.test(args)) {
        index = close;
        continue;
      }
      index = open + 1;
      continue;
    }
    index++;
  }
  return found;
}

function skipString(value: string, start: number): number {
  const quote = value[start];
  let index = start + 1;
  while (index < value.length && value[index] !== quote) index += value[index] === "\\" ? 2 : 1;
  return index + 1;
}

/** The offset just after the `)` closing the `(` at `open`, or the value's end. */
function matchingParen(value: string, open: number): number {
  let depth = 0;
  let index = open;
  while (index < value.length) {
    const char = value[index]!;
    if (char === '"' || char === "'") {
      index = skipString(value, index);
      continue;
    }
    if (char === "/" && value[index + 1] === "*") {
      const end = value.indexOf("*/", index + 2);
      index = end === -1 ? value.length : end + 2;
      continue;
    }
    if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return index + 1;
    index++;
  }
  return value.length;
}
