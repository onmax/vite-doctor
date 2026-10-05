import { existsSync, readFileSync, statSync } from "node:fs";
import { glob } from "node:fs/promises";
import { resolve } from "pathe";
import { parseSync } from "oxc-parser";
import type { RuleContext, SourceRange } from "../../../core/index.js";
import { createVueScriptForParsing } from "../../../core/internal/sfc.js";
import { parseTypeScript } from "./estree.js";

export type AnyNode = any;

export function globalReferenceStarts(
  ctx: RuleContext,
  names: ReadonlySet<string>,
): Set<number> | null {
  const parsedVueScript = ctx.file.sfc
    ? createVueScriptForParsing(ctx.file.sfc.descriptor, ctx.file.text)
    : undefined;
  try {
    const { scopeManager } = parseTypeScript(parsedVueScript?.text ?? ctx.file.text, {
      sourceType: "module",
      jsx:
        parsedVueScript?.lang === "jsx" ||
        parsedVueScript?.lang === "tsx" ||
        /\.[jt]sx$/.test(ctx.file.relativePath),
    });
    return new Set(
      scopeManager.globalScope?.through
        .filter((reference) => names.has(reference.identifier.name))
        .map((reference) => reference.identifier.range[0]),
    );
  } catch {
    // Parser disagreement leaves lexical resolution unknown, so callers remain conservative.
    return null;
  }
}

export const SECRET_NAME_RE = /(SECRET|TOKEN|PASSWORD|PRIVATE|API_?KEY|ACCESS_?KEY)/i;
export const VITE_CONFIG_RE = /(?:^|\/)(?:vite|vitest)\.config\.[cm]?[jt]s$/;
export const SOURCE_GLOB = "**/*.{vue,ts,tsx,js,jsx,mjs,cjs,mts,cts}";
export const SOURCE_EXCLUDE = [
  "**/node_modules/**",
  "**/.nuxt/**",
  "**/.output/**",
  "**/dist/**",
  "**/coverage/**",
  "**/*.d.ts",
];

export interface ViteConfigFact {
  file: string;
  text: string;
  define: Array<{ key: string; range: SourceRange; rawValue: string }>;
  envPrefixes: Array<{ value: string; range: SourceRange }>;
}

export async function readViteConfigFacts(ctx: RuleContext): Promise<ViteConfigFact[]> {
  const files = new Set<string>();
  for (const pattern of [
    "vite.config.{ts,js,mjs,cjs,mts,cts}",
    "vitest.config.{ts,js,mjs,cjs,mts,cts}",
  ]) {
    for await (const entry of glob(pattern, { cwd: ctx.project.root })) {
      if (typeof entry === "string") files.add(resolve(ctx.project.root, entry));
    }
  }
  return [...files].sort().map((file) => {
    const text = readFileSync(file, "utf8");
    return {
      file,
      text,
      define: extractDefineEntries(ctx, file, text),
      envPrefixes: extractEnvPrefixes(ctx, file, text),
    };
  });
}

export async function readProjectSources(
  ctx: RuleContext,
): Promise<Array<{ file: string; text: string }>> {
  const files: Array<{ file: string; text: string }> = [];
  for await (const entry of glob(SOURCE_GLOB, { cwd: ctx.project.root, exclude: SOURCE_EXCLUDE })) {
    if (typeof entry !== "string") continue;
    const file = resolve(ctx.project.root, entry);
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) continue;
    files.push({ file, text: readFileSync(file, "utf8") });
  }
  return files;
}

export function isViteConfigFile(path: string): boolean {
  return VITE_CONFIG_RE.test(path);
}

export function isLikelyWorkerFile(path: string): boolean {
  return /(?:^|[./-])worker(?:[./-]|$)|\.worker\.[cm]?[jt]sx?$/.test(path);
}

export function isLikelySsrFile(path: string): boolean {
  return /(?:^|\/)(entry-server|server|ssr|renderer)\.[cm]?[jt]sx?$/.test(path);
}

export function staticString(node: AnyNode): string | null {
  node = unwrapTypeExpression(node);
  if (!node) return null;
  if (typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions?.length === 0)
    return String(node.quasis?.[0]?.value?.cooked ?? node.quasis?.[0]?.value?.raw ?? "");
  return null;
}

export function propertyName(node: AnyNode): string | null {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "PrivateIdentifier") return node.name;
  if (typeof node.value === "string" || typeof node.value === "number") return String(node.value);
  return null;
}

export function memberPath(node: AnyNode): string | null {
  node = unwrapTypeExpression(node);
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "MetaProperty") return `${node.meta?.name}.${node.property?.name}`;
  if (node.type !== "MemberExpression") return null;
  const object = memberPath(node.object);
  const key = unwrapTypeExpression(node.property);
  const property = node.computed && key?.type !== "Literal" ? staticString(key) : propertyName(key);
  return object && property ? `${object}.${property}` : null;
}

function unwrapTypeExpression(node: AnyNode): AnyNode {
  while (
    node &&
    [
      "TSAsExpression",
      "TSTypeAssertion",
      "TSSatisfiesExpression",
      "TSNonNullExpression",
      "ParenthesizedExpression",
    ].includes(node.type)
  )
    node = node.expression;
  return node;
}

export function hasTypeDeclaration(ctx: RuleContext, name: string, env = false): boolean {
  const cacheKey = `vite:global-type-declarations:${ctx.project.root}`;
  let declarations = ctx.cache.get<{ globals: Set<string>; env: Set<string> }>(cacheKey);
  if (declarations) return (env ? declarations.env : declarations.globals).has(name);
  declarations = { globals: new Set(), env: new Set() };
  const interfaces = new Map<string, AnyNode[]>();
  const collect = (statements: AnyNode[]) => {
    for (const statement of statements) {
      const declaration =
        statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
      if (declaration?.type === "VariableDeclaration") {
        for (const item of declaration.declarations) {
          if (item.id.type === "Identifier") declarations.globals.add(item.id.name);
        }
      }
      if (declaration?.type === "TSInterfaceDeclaration")
        interfaces.set(declaration.id.name, [
          ...(interfaces.get(declaration.id.name) ?? []),
          declaration,
        ]);
    }
  };
  for (const file of findDeclarationFiles(ctx.project.root)) {
    const { program } = parseSync(file, readFileSync(file, "utf8"), {
      lang: "dts",
      sourceType: "module",
      astType: "ts",
    });
    if (!isExternalModule(program.body)) collect(program.body);
    else {
      for (const statement of program.body as AnyNode[]) {
        if (statement.type === "TSModuleDeclaration" && statement.kind === "global")
          collect(statement.body?.body ?? []);
      }
    }
  }
  const visitInterface = (name: string, seen = new Set<string>()) => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const declaration of interfaces.get(name) ?? []) {
      for (const member of declaration.body.body) {
        if (member.type !== "TSPropertySignature" && member.type !== "TSMethodSignature") continue;
        const key = member.key;
        if (key.type === "Identifier" && !member.computed) declarations.env.add(key.name);
        if (key.type === "Literal" && typeof key.value === "string")
          declarations.env.add(key.value);
      }
      for (const heritage of declaration.extends ?? []) {
        if (heritage.expression.type === "Identifier")
          visitInterface(heritage.expression.name, seen);
      }
    }
  };
  visitInterface("ImportMetaEnv");
  ctx.cache.set(cacheKey, declarations);
  return (env ? declarations.env : declarations.globals).has(name);
}

export function isLiteralPrimitive(rawValue: string): boolean {
  return /^(?:["'`][\s\S]*["'`]|true|false|null|undefined|-?\d+(?:\.\d+)?)$/.test(rawValue.trim());
}

function extractDefineEntries(ctx: RuleContext, file: string, text: string) {
  const defineBody = objectBodyAfterKey(text, "define");
  if (!defineBody) return [];
  const entries: Array<{ key: string; range: SourceRange; rawValue: string }> = [];
  const re = /(["']?)([A-Z_$][\w$]*(?:\.[A-Z_$][\w$]*)?)\1\s*:\s*([^,\n}]+)/g;
  for (const match of defineBody.body.matchAll(re)) {
    const key = match[2]!;
    const rawValue = match[3]!.trim();
    const start = defineBody.start + match.index! + match[0].indexOf(key);
    entries.push({
      key,
      rawValue,
      range: ctx.helpers.rangeFromOffsets(file, text, start, start + key.length),
    });
  }
  return entries;
}

function extractEnvPrefixes(ctx: RuleContext, file: string, text: string) {
  const entries: Array<{ value: string; range: SourceRange }> = [];
  const direct = /\benvPrefix\s*:\s*["'`]([^"'`]*)["'`]/g;
  for (const match of text.matchAll(direct)) {
    const value = match[1]!;
    const start = match.index! + match[0].indexOf(value);
    entries.push({
      value,
      range: ctx.helpers.rangeFromOffsets(file, text, start, start + value.length),
    });
  }
  const array = /\benvPrefix\s*:\s*\[([^\]]*)\]/g;
  for (const match of text.matchAll(array)) {
    const base = match.index! + match[0].indexOf(match[1]!);
    for (const item of match[1]!.matchAll(/["'`]([^"'`]*)["'`]/g)) {
      const value = item[1]!;
      const start = base + item.index! + item[0].indexOf(value);
      entries.push({
        value,
        range: ctx.helpers.rangeFromOffsets(file, text, start, start + value.length),
      });
    }
  }
  return entries;
}

function objectBodyAfterKey(text: string, key: string): { start: number; body: string } | null {
  const keyMatch = new RegExp(`\\b${key}\\s*:\\s*\\{`).exec(text);
  if (!keyMatch) return null;
  const open = keyMatch.index + keyMatch[0].lastIndexOf("{");
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    const char = text[index];
    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return { start: open + 1, body: text.slice(open + 1, index) };
    }
  }
  return null;
}

// Matches TypeScript's external module detection: top-level import or export syntax only.
function isExternalModule(statements: AnyNode[]): boolean {
  return statements.some(
    (statement) =>
      statement.type === "ImportDeclaration" ||
      statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportDefaultDeclaration" ||
      statement.type === "ExportAllDeclaration" ||
      statement.type === "TSExportAssignment" ||
      (statement.type === "TSImportEqualsDeclaration" &&
        statement.moduleReference.type === "TSExternalModuleReference"),
  );
}

function findDeclarationFiles(root: string): string[] {
  const candidates = ["vite-env.d.ts", "env.d.ts", "src/vite-env.d.ts", "src/env.d.ts"];
  return candidates.map((file) => resolve(root, file)).filter((file) => existsSync(file));
}
