import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "pathe";
import { AnyNode, createRule } from "./shared.js";
import { parseScript } from "./script.js";

interface LocaleMessage {
  key: string;
  file: string;
  valueStart?: number;
  locale: string;
}

const I18N_PACKAGE_NAMES = new Set(["vue-i18n", "@nuxtjs/i18n"]);
const STATIC_TEXT_ATTRIBUTES = new Set(["alt", "aria-label", "label", "placeholder", "title"]);

export const noUnusedTranslations = createRule({
  meta: {
    id: "vue/i18n/no-unused-translations",
    title: "Disallow unused translations",
    category: "i18n",
    severity: "warn",
    requires: { vue: true, crossFile: true },
    requiresContext: ["cross-file"],
    execution: "manifest",
    cost: "medium",
  },
  create(ctx) {
    return {
      onProjectEnd() {
        const inventory = collectI18nInventory(ctx.project.root);
        if (!inventory.hasI18n) return;
        const usedKeys = collectUsedTranslationKeys(ctx.project.root);
        const baseLocale = selectBaseLocale(inventory.messages);
        for (const message of inventory.messages) {
          if (message.locale !== baseLocale || usedKeys.has(message.key)) continue;
          const text = readFileSync(message.file, "utf8");
          ctx.report({
            ruleId: "vue/i18n/no-unused-translations",
            severity: "warn",
            category: "i18n",
            file: message.file,
            range: ctx.helpers.rangeFromOffsets(
              message.file,
              text,
              message.valueStart ?? findKeyOffset(text, message.key),
            ),
            message: `Translation key "${message.key}" is not used by any static Vue i18n call.`,
            suggestion:
              "Remove the unused key or add a static t()/$t() reference if it is still needed.",
          });
        }
      },
    };
  },
});

export const noUntranslatedText = createRule({
  meta: {
    id: "vue/i18n/no-untranslated-text",
    title: "Disallow untranslated visible text",
    category: "i18n",
    severity: "warn",
    requires: { template: true, vue: true },
  },
  create(ctx) {
    const cacheKey = `vue-i18n:project-has-i18n:${ctx.project.root}`;
    let hasI18n = ctx.cache.get<boolean>(cacheKey);
    if (hasI18n === undefined) {
      hasI18n = projectHasI18n(ctx.project.root);
      ctx.cache.set(cacheKey, hasI18n);
    }
    if (!hasI18n) return;
    return {
      TemplateNode(node: AnyNode) {
        if (node.type === "VText") {
          const value = normalizeVisibleText(node.value ?? "");
          if (!isUserFacingText(value)) return;
          ctx.helpers.report(ctx, node, {
            ruleId: "vue/i18n/no-untranslated-text",
            severity: "warn",
            category: "i18n",
            message: `Visible text "${truncate(value)}" should come from Vue i18n.`,
            suggestion: "Replace the hardcoded text with t(), $t(), or <i18n-t>.",
          });
        }

        if (node.type !== "VAttribute") return;
        const name = String(node.key?.name ?? "");
        if (!STATIC_TEXT_ATTRIBUTES.has(name)) return;
        const value = normalizeVisibleText(node.value?.value ?? "");
        if (!isUserFacingText(value)) return;
        ctx.helpers.report(ctx, node, {
          ruleId: "vue/i18n/no-untranslated-text",
          severity: "warn",
          category: "i18n",
          message: `Attribute "${name}" contains untranslated text "${truncate(value)}".`,
          suggestion: "Bind the attribute to t() or $t().",
        });
      },
    };
  },
});

function collectI18nInventory(root: string): { hasI18n: boolean; messages: LocaleMessage[] } {
  const messages = collectLocaleMessages(root);
  return { hasI18n: messages.length > 0 || projectHasI18nPackage(root), messages };
}

function projectHasI18n(root: string): boolean {
  return collectLocaleFiles(root).length > 0 || projectHasI18nPackage(root);
}

function projectHasI18nPackage(root: string): boolean {
  const pkg = readJson(resolve(root, "package.json")) as any;
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies, ...pkg?.peerDependencies };
  return Object.keys(deps).some((name) => I18N_PACKAGE_NAMES.has(name));
}

function collectLocaleMessages(root: string): LocaleMessage[] {
  const messages: LocaleMessage[] = [];
  for (const file of collectLocaleFiles(root)) {
    const text = readFileSync(file, "utf8");
    const object = file.endsWith(".json") ? parseJsonObject(text) : parseModuleMessages(file, text);
    if (!object) continue;
    const locale = localeNameFromFile(file);
    for (const [key, value] of flattenMessages(object)) {
      messages.push({
        key,
        file,
        locale,
        valueStart: findKeyOffset(text, key, value),
      });
    }
  }
  return messages;
}

function collectLocaleFiles(root: string): string[] {
  const dirs = [
    "locales",
    "i18n/locales",
    ...collectNuxtI18nLangDirs(root).map((dir) => dir.replace(/^\.\//, "")),
  ];
  const files = new Set<string>();
  for (const dir of dirs) {
    const absoluteDir = resolve(root, dir);
    if (!statSync(absoluteDir, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const pattern of ["*.json", "*.js", "*.mjs", "*.cjs", "*.ts", "*.mts", "*.cts"]) {
      for (const file of globSyncLike(`${dir}/${pattern}`, root)) files.add(file);
    }
  }
  return [...files].sort();
}

function collectNuxtI18nLangDirs(root: string): string[] {
  const dirs = new Set<string>();
  for (const configName of ["nuxt.config.ts", "nuxt.config.js", "nuxt.config.mjs"]) {
    const file = resolve(root, configName);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/\blangDir\s*:\s*["'`]([^"'`]+)["'`]/g)) {
      dirs.add(match[1]!);
    }
  }
  return [...dirs];
}

function globSyncLike(pattern: string, root: string): string[] {
  const dir = dirname(resolve(root, pattern));
  const prefix = pattern.slice(0, pattern.indexOf("*"));
  const extension = pattern.slice(pattern.lastIndexOf("."));
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return Array.from(new BunGlobCompat(dir, prefix, extension, root));
}

class BunGlobCompat {
  constructor(
    private dir: string,
    private prefix: string,
    private extension: string,
    private root: string,
  ) {}

  *[Symbol.iterator]() {
    for (const entry of readdirSync(this.dir)) {
      if (!entry.endsWith(this.extension)) continue;
      const file = resolve(this.root, this.prefix + entry);
      if (statSync(file, { throwIfNoEntry: false })?.isFile()) yield file;
    }
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseModuleMessages(file: string, text: string): Record<string, unknown> | null {
  const ast = parseScript(file, text);
  let found: Record<string, unknown> | null = null;
  walkAny(ast, (node: AnyNode) => {
    if (found) return;
    if (node.type === "ExportDefaultDeclaration") {
      found = evaluateStaticObject(node.declaration);
    }
    if (
      node.type === "CallExpression" &&
      ["defineI18nLocale", "defineI18nConfig"].includes(node.callee?.name)
    ) {
      const argument = node.arguments?.[0];
      found = evaluateStaticObject(argument);
    }
  });
  return found;
}

function evaluateStaticObject(node: AnyNode): Record<string, unknown> | null {
  if (!node) return null;
  if (node.type === "ObjectExpression") {
    const object: Record<string, unknown> = {};
    for (const property of node.properties ?? []) {
      if (property.type !== "Property") continue;
      const key = staticPropertyKey(property.key);
      if (!key) continue;
      object[key] = evaluateStaticValue(property.value);
    }
    return object;
  }
  if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
    return evaluateStaticObject(node.body);
  }
  return null;
}

function evaluateStaticValue(node: AnyNode): unknown {
  if (!node) return undefined;
  if (node.type === "StringLiteral" || node.type === "Literal") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions?.length === 0)
    return node.quasis?.[0]?.value?.cooked ?? node.quasis?.[0]?.value?.raw;
  if (node.type === "ObjectExpression") return evaluateStaticObject(node);
  return undefined;
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
    if (value && typeof value === "object" && !Array.isArray(value)) {
      entries.push(...flattenMessages(value as Record<string, unknown>, path));
    } else if (typeof value === "string") {
      entries.push([path, value]);
    }
  }
  return entries;
}

function collectUsedTranslationKeys(root: string): Set<string> {
  const used = new Set<string>();
  for (const file of collectSourceFiles(root)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(
      /(?<![\w$])(?:\$t|\$te|t|te)\s*\(\s*(['"`])([A-Za-z0-9_.:-]+)\1/g,
    )) {
      used.add(match[2]!);
    }
    for (const match of text.matchAll(
      /\bi18n\.global\.(?:t|te)\s*\(\s*(['"`])([A-Za-z0-9_.:-]+)\1/g,
    )) {
      used.add(match[2]!);
    }
  }
  return used;
}

function collectSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const pattern of ["**/*.vue", "**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"]) {
    for (const file of globSyncRecursive(root, pattern)) files.push(file);
  }
  return files;
}

function globSyncRecursive(root: string, pattern: string): string[] {
  const files: string[] = [];
  const extension = pattern.slice(pattern.lastIndexOf("."));
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".nuxt", ".output", "dist", "coverage", "public"].includes(entry.name))
        continue;
      const absolute = resolve(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && absolute.endsWith(extension)) files.push(absolute);
    }
  };
  visit(root);
  return files;
}

function selectBaseLocale(messages: LocaleMessage[]): string {
  const locales = [...new Set(messages.map((message) => message.locale))].sort();
  return locales.find((locale) => /^en(?:[-_]|$)/i.test(locale)) ?? locales[0] ?? "";
}

function localeNameFromFile(file: string): string {
  return file
    .split("/")
    .pop()!
    .replace(/\.(json|[cm]?[jt]s)$/, "");
}

function findKeyOffset(text: string, key: string, value?: string): number {
  const leaf = key.split(".").at(-1) ?? key;
  const keyIndex = text.search(new RegExp(`["'\`]${escapeRegExp(leaf)}["'\`]\\s*:`));
  if (keyIndex >= 0) return keyIndex;
  if (value) {
    const valueIndex = text.indexOf(value);
    if (valueIndex >= 0) return valueIndex;
  }
  return 0;
}

function normalizeVisibleText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isUserFacingText(value: string): boolean {
  if (!value) return false;
  if (value.length < 2) return false;
  if (/^[\d\s.,:;!?()[\]{}'"`/\\|+*=<>_-]+$/.test(value)) return false;
  if (/^(https?:|\/|#|[\w-]+\/[\w-]+)/.test(value)) return false;
  if (/^[a-z0-9_.:-]+$/.test(value) && !/\s/.test(value)) return false;
  return /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(value);
}

function truncate(value: string): string {
  return value.length > 60 ? `${value.slice(0, 57)}...` : value;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function walkAny(node: unknown, visit: (node: AnyNode) => void) {
  if (!node || typeof node !== "object") return;
  const typed = node as AnyNode;
  if (typeof typed.type === "string") visit(typed);
  for (const [key, value] of Object.entries(typed)) {
    if (key === "__doctorParent") continue;
    if (Array.isArray(value)) {
      for (const child of value) walkAny(child, visit);
    } else if (value && typeof value === "object") {
      walkAny(value, visit);
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
