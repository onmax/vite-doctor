import { resolve } from "pathe";
import type {
  RuleFileSystem,
  TemplateAstNode,
  TemplateExpressionNode,
} from "../../../../core/index.js";
import { loadVueCompilerSfc } from "../../../../core/internal/lazy-parsers.js";
import { parseScriptResult } from "../../../../core/internal/script.js";
import { parseVueScriptsResult } from "../../../../core/internal/sfc.js";
import {
  SFC_TEMPLATE_PARSE_OPTIONS,
  TemplateNodeType,
  parseTemplateExpression,
  templateAstFromDescriptor,
  walkTemplate,
} from "../../../../core/internal/template.js";
import type { LocaleMessage } from "./i18n-locales.js";
import type { AnyNode } from "./shared.js";

export interface DynamicReference {
  file: string;
  start: number;
  end: number;
}

export interface TranslationUsage {
  sourceFiles: number;
  /** Translation calls, `<i18n-t>` keypaths, and `v-t` values, static or not. */
  references: number;
  keys: Set<string>;
  /** Keys reachable through a static prefix, a template literal, or `tm()` of a subtree. */
  patterns: RegExp[];
  /** String literals in source that may hold a key passed around before it reaches `t()`. */
  literals: Set<string>;
  dynamic: DynamicReference[];
  /** Files whose usage Doctor could only scan with a fallback pattern. */
  unparsedFiles: string[];
}

type KeyFunction = "t" | "tm";

interface FileScope {
  aliases: Map<string, KeyFunction>;
  i18nObjects: Set<string>;
}

const SOURCE_EXTENSIONS = [".vue", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
const SOURCE_IGNORED_ENTRIES = new Set([
  "node_modules",
  ".git",
  ".nuxt",
  ".output",
  ".vercel",
  ".netlify",
  ".data",
  ".cache",
  "dist",
  "coverage",
  "public",
]);
// rt() renders an already resolved message and d()/n() format values, so none of them names a key.
const KEY_FUNCTIONS = new Map<string, KeyFunction>([
  ["t", "t"],
  ["$t", "t"],
  ["te", "t"],
  ["$te", "t"],
  ["tc", "t"],
  ["$tc", "t"],
  ["tm", "tm"],
  ["$tm", "tm"],
]);
const TRANSLATION_COMPONENTS = new Map([
  ["i18n-t", "keypath"],
  ["I18nT", "keypath"],
  ["i18n", "path"],
]);
const MAX_KEY_CANDIDATES = 16;
const I18N_HINT = /(?<![\w$])\$?(?:t|te|tc|tm)\s*\(|keypath|\bpath=|v-t\b|i18n/i;

export function collectTranslationUsage(
  fs: RuleFileSystem,
  root: string,
  localeFiles: ReadonlySet<string>,
  messages: readonly LocaleMessage[],
): TranslationUsage {
  const usage: TranslationUsage = {
    sourceFiles: 0,
    references: 0,
    keys: new Set(),
    patterns: [],
    literals: new Set(),
    dynamic: [],
    unparsedFiles: [],
  };
  for (const file of collectSourceFiles(fs, root)) {
    if (localeFiles.has(file)) continue;
    const text = fs.readText(file);
    if (text === undefined) continue;
    usage.sourceFiles++;
    collectStringLiterals(text, usage.literals);
    if (!I18N_HINT.test(text)) continue;
    if (file.endsWith(".vue")) scanVueFile(file, text, usage);
    else scanScriptFile(file, text, usage);
  }
  for (const message of messages) collectLinkedKeys(message, usage);
  usage.dynamic.sort(
    (left, right) => left.file.localeCompare(right.file) || left.start - right.start,
  );
  return usage;
}

export function isKeyUsed(usage: TranslationUsage, key: string): boolean {
  return (
    usage.keys.has(key) ||
    usage.literals.has(key) ||
    usage.patterns.some((pattern) => pattern.test(key))
  );
}

function scanScriptFile(file: string, text: string, usage: TranslationUsage) {
  const parsed = parseScriptResult(file, text);
  if (!parsed.ast || parsed.incomplete) return scanUnparsed(file, text, usage);
  const scope = collectScope(parsed.ast);
  walkCalls(parsed.ast, file, scope, usage, 0);
}

function scanVueFile(file: string, text: string, usage: TranslationUsage) {
  const { descriptor, errors } = loadVueCompilerSfc().parse(text, {
    filename: file,
    sourceMap: false,
    templateParseOptions: SFC_TEMPLATE_PARSE_OPTIONS,
  });
  const scripts = parseVueScriptsResult(file, descriptor, text);
  const template = templateAstFromDescriptor(descriptor);
  if (
    errors.length > 0 ||
    scripts.incomplete ||
    (descriptor.template && !template) ||
    ((descriptor.script || descriptor.scriptSetup) && !scripts.ast)
  )
    return scanUnparsed(file, text, usage);
  const scope = scripts.ast ? collectScope(scripts.ast) : emptyScope();
  if (scripts.ast) walkCalls(scripts.ast, file, scope, usage, 0);
  if (template) scanTemplate(template, file, scope, usage);
}

function scanTemplate(
  root: TemplateAstNode,
  file: string,
  scope: FileScope,
  usage: TranslationUsage,
) {
  walkTemplate(root, (node) => {
    if (node.type === TemplateNodeType.ELEMENT) {
      const keyAttribute = TRANSLATION_COMPONENTS.get(node.tag);
      if (!keyAttribute) return;
      for (const prop of node.props) {
        if (prop.type === TemplateNodeType.ATTRIBUTE && prop.name === keyAttribute) {
          usage.references++;
          if (prop.value?.content) usage.keys.add(prop.value.content);
        } else if (
          prop.type === TemplateNodeType.DIRECTIVE &&
          prop.name === "bind" &&
          prop.arg?.isStatic &&
          prop.arg.content === keyAttribute &&
          prop.exp
        ) {
          const expression = parseTemplateExpression(prop.exp);
          recordKeyArgument(expression, file, expressionLocation(expression, prop.exp), "t", usage);
        }
      }
      return;
    }
    if (node.type === TemplateNodeType.INTERPOLATION) {
      scanTemplateExpression(node.content as TemplateExpressionNode, file, scope, usage);
      return;
    }
    if (node.type !== TemplateNodeType.DIRECTIVE) return;
    if (node.name === "t" && node.exp) {
      const expression = parseTemplateExpression(node.exp);
      const path =
        expression?.type === "ObjectExpression"
          ? (expression as AnyNode).properties?.find(
              (property: AnyNode) => staticName(property.key) === "path",
            )?.value
          : expression;
      recordKeyArgument(path, file, expressionLocation(expression, node.exp), "t", usage);
    }
    if (node.name === "slot") return;
    const expression = node.name === "for" ? node.forParseResult?.source : node.exp;
    if (expression) scanTemplateExpression(expression, file, scope, usage);
  });
}

function scanTemplateExpression(
  expression: TemplateExpressionNode,
  file: string,
  scope: FileScope,
  usage: TranslationUsage,
) {
  if (expression.isStatic || !expression.content.trim()) return;
  const parsed = parseTemplateExpression(expression);
  if (parsed) return walkCalls(parsed, file, scope, usage, 0);
  // Multi-statement v-on handlers are not one expression; parse them as a program instead.
  const program = parseScriptResult("template-handler.ts", expression.content);
  if (program.ast && !program.incomplete)
    walkCalls(program.ast, file, scope, usage, expression.loc.start.offset);
  else if (!usage.unparsedFiles.includes(file)) usage.unparsedFiles.push(file);
}

function walkCalls(
  ast: unknown,
  file: string,
  scope: FileScope,
  usage: TranslationUsage,
  offset: number,
) {
  walk(ast, (node) => {
    if (node.type !== "CallExpression") return;
    const kind = calleeKind(node.callee, scope);
    if (!kind || !node.arguments?.[0]) return;
    recordKeyArgument(
      node.arguments[0],
      file,
      { start: node.start + offset, end: node.end + offset },
      kind,
      usage,
    );
  });
}

function recordKeyArgument(
  argument: AnyNode,
  file: string,
  location: { start: number; end: number },
  kind: KeyFunction,
  usage: TranslationUsage,
) {
  usage.references++;
  const candidates = argument ? keyCandidates(argument) : [[null]];
  let dynamic = candidates.length > MAX_KEY_CANDIDATES;
  for (const parts of dynamic ? [] : candidates) {
    if (parts.every((part) => typeof part === "string")) {
      const key = parts.join("");
      usage.keys.add(key);
      if (kind === "tm") usage.patterns.push(new RegExp(`^${escapeRegExp(key)}\\.`));
    } else if (parts.every((part) => !part)) {
      dynamic = true;
    } else {
      const source = parts.map((part) => (part === null ? ".*" : escapeRegExp(part))).join("");
      usage.patterns.push(new RegExp(`^${source}${kind === "tm" ? "(?:\\..*)?" : ""}$`));
    }
  }
  if (dynamic) usage.dynamic.push({ file, ...location });
}

function expressionLocation(
  parsed: AnyNode,
  expression: TemplateExpressionNode,
): { start: number; end: number } {
  return parsed
    ? { start: parsed.start, end: parsed.end }
    : { start: expression.loc.start.offset, end: expression.loc.end.offset };
}

/** Each candidate is the key as literal parts, with `null` where a runtime value goes. */
function keyCandidates(node: AnyNode): Array<Array<string | null>> {
  node = unwrap(node);
  if (!node) return [[null]];
  if (typeof node.value === "string" && (node.type === "Literal" || node.type === "StringLiteral"))
    return [[node.value]];
  if (node.type === "TemplateLiteral") {
    const parts: Array<string | null> = [];
    (node.quasis ?? []).forEach((quasi: AnyNode, index: number) => {
      if (index > 0) parts.push(null);
      parts.push(quasi.value?.cooked ?? quasi.value?.raw ?? "");
    });
    return [parts];
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = keyCandidates(node.left);
    const right = keyCandidates(node.right);
    if (left.length * right.length > MAX_KEY_CANDIDATES) return [[null]];
    return left.flatMap((head) => right.map((tail) => [...head, ...tail]));
  }
  if (node.type === "ConditionalExpression")
    return [...keyCandidates(node.consequent), ...keyCandidates(node.alternate)];
  if (node.type === "LogicalExpression")
    return [...keyCandidates(node.left), ...keyCandidates(node.right)];
  return [[null]];
}

function calleeKind(callee: AnyNode, scope: FileScope): KeyFunction | null {
  callee = unwrap(callee);
  if (callee?.type === "Identifier")
    return scope.aliases.get(callee.name) ?? KEY_FUNCTIONS.get(callee.name) ?? null;
  if (callee?.type !== "MemberExpression" || callee.computed) return null;
  const name = staticName(callee.property);
  const kind = name ? KEY_FUNCTIONS.get(name) : undefined;
  if (!kind) return null;
  if (name!.startsWith("$") || mentionsI18n(callee.object)) return kind;
  const object = unwrap(callee.object);
  return object?.type === "Identifier" && scope.i18nObjects.has(object.name) ? kind : null;
}

function collectScope(ast: unknown): FileScope {
  const scope = emptyScope();
  walk(ast, (node) => {
    if (node.type !== "VariableDeclarator") return;
    const init = unwrap(node.init);
    const fromUseI18n =
      init?.type === "CallExpression" && unwrap(init.callee)?.type === "Identifier"
        ? unwrap(init.callee).name === "useI18n"
        : false;
    if (!fromUseI18n && !mentionsI18n(init)) return;
    if (node.id?.type === "Identifier") scope.i18nObjects.add(node.id.name);
    if (node.id?.type !== "ObjectPattern") return;
    for (const property of node.id.properties ?? []) {
      const name = staticName(property.key);
      const kind = name ? KEY_FUNCTIONS.get(name) : undefined;
      const value =
        property.value?.type === "AssignmentPattern" ? property.value.left : property.value;
      if (kind && value?.type === "Identifier") scope.aliases.set(value.name, kind);
    }
  });
  return scope;
}

function mentionsI18n(node: AnyNode): boolean {
  node = unwrap(node);
  while (node) {
    if (node.type === "Identifier") return /i18n/i.test(node.name);
    if (node.type === "MemberExpression") {
      if (/i18n/i.test(staticName(node.property) ?? "")) return true;
      node = unwrap(node.object);
    } else if (node.type === "CallExpression") {
      node = unwrap(node.callee);
    } else return false;
  }
  return false;
}

function emptyScope(): FileScope {
  return { aliases: new Map(), i18nObjects: new Set() };
}

function scanUnparsed(file: string, text: string, usage: TranslationUsage) {
  usage.unparsedFiles.push(file);
  for (const match of text.matchAll(
    /(?<![\w$])\$?(?:t|te|tc|tm)\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g,
  )) {
    usage.references++;
    if (match[1] === "`" && match[2]!.includes("${")) continue;
    usage.keys.add(unescapeString(match[2]!));
  }
  for (const match of text.matchAll(/\b(?:keypath|path)\s*=\s*(['"])([^'"]+)\1/g))
    usage.keys.add(match[2]!);
}

// Starts a candidate at every quote so text such as "Don't" cannot swallow a later literal.
// Spans between two literals also land in the set; only exact key matches are ever looked up.
function collectStringLiterals(text: string, literals: Set<string>) {
  for (const match of text.matchAll(/(?=(['"`])((?:\\.|(?!\1)[^\\\n])*)\1)/g)) {
    const value = match[2]!;
    if (value && value.length <= 200) literals.add(unescapeString(value));
  }
}

const LINKED_MESSAGE =
  /@(?:\.[A-Za-z]+)?:(?:\{\s*(['"])(.+?)\1\s*\}|\(([^)]+)\)|(\{[^}]*\})|([^\s{}()@,;!?'"`|<>]+))/g;

function collectLinkedKeys(message: LocaleMessage, usage: TranslationUsage) {
  if (!message.value.includes("@")) return;
  for (const match of message.value.matchAll(LINKED_MESSAGE)) {
    const key = match[2] ?? match[3] ?? match[5]?.replace(/\.+$/, "");
    if (key) {
      usage.keys.add(key.trim());
      continue;
    }
    // `@:{name}` links to whatever key the named parameter holds at runtime.
    const start = Math.max(message.file.text.indexOf(match[0]), 0);
    usage.dynamic.push({ file: message.file.path, start, end: start + match[0].length });
  }
}

function collectSourceFiles(fs: RuleFileSystem, root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readDir(dir) ?? []) {
      if (SOURCE_IGNORED_ENTRIES.has(entry.name)) continue;
      const absolute = resolve(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.some((extension) => absolute.endsWith(extension))
      )
        files.push(absolute);
    }
  };
  visit(root);
  return files.sort();
}

function staticName(node: AnyNode): string | null {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "Literal" || node?.type === "StringLiteral") return String(node.value);
  return null;
}

function unwrap(node: AnyNode): AnyNode {
  while (
    node &&
    (node.type === "TSAsExpression" ||
      node.type === "TSSatisfiesExpression" ||
      node.type === "TSNonNullExpression" ||
      node.type === "ParenthesizedExpression" ||
      node.type === "ChainExpression" ||
      node.type === "AwaitExpression")
  )
    node = node.expression ?? node.argument;
  return node;
}

function walk(node: unknown, visit: (node: AnyNode) => void) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const typed = node as AnyNode;
  if (typeof typed.type === "string") visit(typed);
  for (const key in typed) {
    if (key === "__doctorParent" || key === "comments") continue;
    const value = typed[key];
    if (value && typeof value === "object") walk(value, visit);
  }
}

function unescapeString(value: string): string {
  return value.includes("\\") ? value.replace(/\\(.)/g, "$1") : value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
