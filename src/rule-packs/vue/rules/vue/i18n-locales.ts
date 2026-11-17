import { basename, resolve } from "pathe";
import type { RuleFileSystem } from "../../../../core/index.js";
import { parseScript } from "./script.js";
import type { AnyNode } from "./shared.js";

export interface LocaleFile {
  path: string;
  text: string;
  quotedKeyOffsets?: Map<string, number>;
}

export interface LocaleMessage {
  key: string;
  /** Other paths that reach the same message, such as `common.save` for `locales/en/common.json`. */
  aliases: string[];
  value: string;
  file: LocaleFile;
  locale: string;
}

export interface LocaleInventory {
  files: string[];
  messages: LocaleMessage[];
  baseLocale: string;
}

interface LocaleSource {
  path: string;
  locale: string;
  namespace?: string;
}

interface NuxtI18nOptions {
  restructureDir?: string;
  langDir?: string;
  defaultLocale?: string;
  locales: Array<{ code: string; files: string[] }>;
}

const LOCALE_EXTENSIONS = [".json", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"];
const DEFAULT_LOCALE_DIRS = ["locales", "i18n/locales"];
const NUXT_CONFIG_FILES = [
  "nuxt.config.ts",
  "nuxt.config.js",
  "nuxt.config.mjs",
  "nuxt.config.mts",
];
const LOCALE_DIR_NAME = /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i;

export function collectLocaleInventory(fs: RuleFileSystem, root: string): LocaleInventory {
  const options = readNuxtI18nOptions(fs, root);
  const sources = collectLocaleSources(fs, root, options);
  const messages: LocaleMessage[] = [];
  for (const source of sources) {
    const text = fs.readText(source.path);
    if (text === undefined) continue;
    const object = source.path.endsWith(".json")
      ? parseJsonObject(text)
      : parseModuleMessages(source.path, text);
    if (!object) continue;
    const file: LocaleFile = { path: source.path, text };
    for (const [key, value] of flattenMessages(object)) {
      messages.push({
        key,
        aliases: source.namespace ? [`${source.namespace}.${key}`] : [],
        value,
        file,
        locale: source.locale,
      });
    }
  }
  return {
    files: sources.map((source) => source.path),
    messages,
    baseLocale: selectBaseLocale(messages, options?.defaultLocale),
  };
}

export function hasLocaleFiles(fs: RuleFileSystem, root: string): boolean {
  return collectLocaleSources(fs, root, readNuxtI18nOptions(fs, root)).length > 0;
}

function collectLocaleSources(
  fs: RuleFileSystem,
  root: string,
  options: NuxtI18nOptions | undefined,
): LocaleSource[] {
  const dirs = DEFAULT_LOCALE_DIRS.map((dir) => resolve(root, dir));
  if (options?.langDir !== undefined || options?.restructureDir !== undefined) {
    const langDir = options.langDir ?? "locales";
    // @nuxtjs/i18n v9+ resolves langDir inside restructureDir; v8 resolved it from the root.
    const configured = [
      resolve(root, options.restructureDir ?? "i18n", langDir),
      resolve(root, langDir),
    ];
    const existing = configured.find((dir) => fs.stat(dir)?.isDirectory());
    if (existing) dirs.push(existing);
  }
  const sources = new Map<string, LocaleSource>();
  for (const dir of new Set(dirs)) {
    if (!fs.stat(dir)?.isDirectory()) continue;
    const declared = new Map<string, string>();
    for (const locale of options?.locales ?? [])
      for (const file of locale.files) declared.set(resolve(dir, file), locale.code);
    for (const entry of fs.readDir(dir) ?? []) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory() && LOCALE_DIR_NAME.test(entry.name)) {
        for (const nested of fs.readDir(path) ?? []) {
          const nestedPath = resolve(path, nested.name);
          if (!nested.isFile() || !isLocaleFileName(nested.name)) continue;
          const code = declared.get(nestedPath);
          sources.set(
            nestedPath,
            code
              ? { path: nestedPath, locale: code }
              : { path: nestedPath, locale: entry.name, namespace: stripExtension(nested.name) },
          );
        }
      } else if (entry.isFile() && isLocaleFileName(entry.name)) {
        sources.set(path, { path, locale: declared.get(path) ?? stripExtension(entry.name) });
      }
    }
  }
  return [...sources.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function selectBaseLocale(messages: LocaleMessage[], defaultLocale: string | undefined): string {
  const locales = [...new Set(messages.map((message) => message.locale))].sort();
  if (defaultLocale && locales.includes(defaultLocale)) return defaultLocale;
  return locales.find((locale) => /^en(?:[-_]|$)/i.test(locale)) ?? locales[0] ?? "";
}

function readNuxtI18nOptions(fs: RuleFileSystem, root: string): NuxtI18nOptions | undefined {
  for (const name of NUXT_CONFIG_FILES) {
    const file = resolve(root, name);
    const text = fs.readText(file);
    if (text === undefined) continue;
    const config = nuxtConfigObject(file, text);
    if (!config) return undefined;
    const merged: Record<string, unknown> = {};
    for (const entry of Array.isArray(config.modules) ? config.modules : [])
      if (Array.isArray(entry) && entry[0] === "@nuxtjs/i18n" && isRecord(entry[1]))
        Object.assign(merged, entry[1]);
    if (isRecord(config.i18n)) Object.assign(merged, config.i18n);
    return {
      restructureDir: stringOrUndefined(merged.restructureDir),
      langDir: stringOrUndefined(merged.langDir),
      defaultLocale: stringOrUndefined(merged.defaultLocale),
      locales: (Array.isArray(merged.locales) ? merged.locales : []).flatMap((locale) => {
        if (!isRecord(locale) || typeof locale.code !== "string") return [];
        const files = [locale.file, ...(Array.isArray(locale.files) ? locale.files : [])]
          .map((file) => (isRecord(file) ? file.path : file))
          .filter((file): file is string => typeof file === "string");
        return [{ code: locale.code, files }];
      }),
    };
  }
  return undefined;
}

function nuxtConfigObject(file: string, text: string): Record<string, unknown> | undefined {
  const ast = parseScript(file, text);
  for (const statement of (ast?.body as AnyNode[] | undefined) ?? []) {
    if (statement.type !== "ExportDefaultDeclaration") continue;
    let declaration = unwrapExpression(statement.declaration);
    if (declaration?.type === "CallExpression") declaration = declaration.arguments?.[0];
    const value = evaluateStaticValue(declaration);
    return isRecord(value) ? value : undefined;
  }
  return undefined;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function parseModuleMessages(file: string, text: string): Record<string, unknown> | null {
  const ast = parseScript(file, text);
  let found: Record<string, unknown> | null = null;
  walkAny(ast, (node: AnyNode) => {
    if (node.type === "ExportDefaultDeclaration") {
      found = evaluateStaticObject(node.declaration);
    }
    if (
      node.type === "CallExpression" &&
      ["defineI18nLocale", "defineI18nConfig"].includes(node.callee?.name)
    ) {
      found = evaluateStaticObject(node.arguments?.[0]);
    }
    return found !== null;
  });
  return found;
}

function evaluateStaticObject(node: AnyNode): Record<string, unknown> | null {
  if (node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression") {
    return evaluateStaticObject(node.body);
  }
  const value = evaluateStaticValue(node);
  return isRecord(value) ? value : null;
}

function evaluateStaticValue(node: AnyNode): unknown {
  node = unwrapExpression(node);
  if (!node) return undefined;
  if (node.type === "StringLiteral" || node.type === "Literal") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions?.length === 0)
    return node.quasis?.[0]?.value?.cooked ?? node.quasis?.[0]?.value?.raw;
  if (node.type === "ArrayExpression")
    return (node.elements ?? []).map((element: AnyNode) => evaluateStaticValue(element));
  if (node.type === "ObjectExpression") {
    const object: Record<string, unknown> = {};
    for (const property of node.properties ?? []) {
      if (property.type !== "Property") continue;
      const key = staticPropertyKey(property.key);
      if (key !== null) object[key] = evaluateStaticValue(property.value);
    }
    return object;
  }
  return undefined;
}

function unwrapExpression(node: AnyNode): AnyNode {
  while (
    node &&
    (node.type === "TSAsExpression" ||
      node.type === "TSSatisfiesExpression" ||
      node.type === "TSNonNullExpression" ||
      node.type === "ParenthesizedExpression")
  )
    node = node.expression;
  return node;
}

function staticPropertyKey(node: AnyNode): string | null {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "StringLiteral" || node.type === "Literal") return String(node.value);
  return null;
}

function flattenMessages(
  object: Record<string, unknown>,
  prefix = "",
): Array<[key: string, value: string]> {
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(object)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isRecord(value)) {
      entries.push(...flattenMessages(value, path));
    } else if (typeof value === "string") {
      entries.push([path, value]);
    }
  }
  return entries;
}

export function findKeyOffset(file: LocaleFile, key: string, value: string): number {
  const leaf = key.split(".").at(-1) ?? key;
  const keyIndex = /["'`]/.test(leaf)
    ? file.text.search(new RegExp(`["'\`]${escapeRegExp(leaf)}["'\`]\\s*:`))
    : ((file.quotedKeyOffsets ??= indexQuotedKeys(file.text)).get(leaf) ?? -1);
  if (keyIndex >= 0) return keyIndex;
  if (value) {
    const valueIndex = file.text.indexOf(value);
    if (valueIndex >= 0) return valueIndex;
  }
  return 0;
}

// Matches what /["'`]<leaf>["'`]\s*:/ finds for every quote-free leaf in one pass: such a match
// always closes on the first quote after its opening quote.
function indexQuotedKeys(text: string): Map<string, number> {
  const offsets = new Map<string, number>();
  const quote = /["'`]/g;
  const colon = /\s*:/y;
  let open = quote.exec(text)?.index;
  while (open !== undefined) {
    const close = quote.exec(text)?.index;
    if (close === undefined) break;
    colon.lastIndex = close + 1;
    if (colon.test(text)) {
      const leaf = text.slice(open + 1, close);
      if (!offsets.has(leaf)) offsets.set(leaf, open);
    }
    open = close;
  }
  return offsets;
}

function isLocaleFileName(name: string): boolean {
  return LOCALE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

function stripExtension(name: string): string {
  return basename(name).replace(/\.(json|[cm]?[jt]s)$/, "");
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function walkAny(node: unknown, visit: (node: AnyNode) => boolean): boolean {
  if (!node || typeof node !== "object") return false;
  const typed = node as AnyNode;
  if (typeof typed.type === "string" && visit(typed)) return true;
  for (const [key, value] of Object.entries(typed)) {
    if (key === "__doctorParent") continue;
    if (Array.isArray(value)) {
      for (const child of value) if (walkAny(child, visit)) return true;
    } else if (value && typeof value === "object" && walkAny(value, visit)) {
      return true;
    }
  }
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
