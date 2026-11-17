import { dirname, join, relative, resolve } from "pathe";
import type { SourceRange, RuleContext } from "../../../../core/index.js";
// oxlint-disable-next-line no-restricted-imports -- callers must respect the authored source exclusions.
import { DEFAULT_EXCLUDE } from "../../../../core/internal/source-inventory.js";
import { createLocalEvidence } from "../../../typescript/rules/local-evidence.js";
import { parseScript } from "../../../../core/internal/script.js";
import { getNodeVisitorKeys } from "../../../../core/internal/visitor-keys.js";
import { nearestFunctionOrProgram, type AnyNode } from "../../../../core/rule-authoring.js";
import { isClientOnlyPath } from "./execution-evidence.js";

const SOURCE_GLOB = "**/*.{vue,ts,tsx,mts,js,jsx,mjs}";
const SOURCE_EXCLUDE = [...DEFAULT_EXCLUDE, "**/*.config.*", "**/{scripts,build}/**"];
const NUXT_CONFIGS = ["nuxt.config.ts", "nuxt.config.js", "nuxt.config.mjs", "nuxt.config.mts"];
// Nuxt runs these callbacks while it renders a request on the server.
const SSR_CALLBACK_CALLEES = new Set(["defineNuxtPlugin", "defineNuxtRouteMiddleware"]);
const AUTO_IMPORTED_PATH = /(?:^|\/)(?:utils|composables)\/(?:[^/]+|[^/]+\/index)\.[cm]?[jt]sx?$/;
const MAX_DEPTH = 4;

interface Source {
  file: string;
  text: string;
  program: AnyNode;
  isModule: boolean;
}

interface Owner {
  name: string;
  exported: boolean;
}

/** A call that runs the function holding a browser global while Nuxt renders on the server. */
export interface SsrCaller {
  file: string;
  line: number;
  callee: string;
  range: SourceRange;
}

/**
 * For a browser global directly inside a top-level plain function of a script module, the call
 * that runs that function during SSR, or `null` when Doctor finds none. `undefined` means the
 * global is not inside such a function, so its own execution evidence decides.
 *
 * A call counts during SSR when it sits at the top level of a script, in a composable body, or in
 * a plugin or route middleware callback, outside client guards. Calls through other top-level
 * plain functions are followed across the file and its importers, including Nuxt auto-imports.
 * Callers Doctor cannot resolve, such as a function passed as a value, are not SSR evidence.
 */
export function browserGlobalSsrCaller(
  ctx: RuleContext,
  node: AnyNode,
): SsrCaller | null | undefined {
  if (ctx.file.isVueSfc || !ctx.file.scriptAst) return undefined;
  const fn = nearestFunctionOrProgram(node);
  if (!fn || fn.type === "Program") return undefined;
  const owner = topLevelFunction(fn);
  if (!owner || isComposableName(owner.name)) return undefined;
  const source: Source = {
    file: ctx.file.path,
    text: ctx.file.text,
    program: ctx.file.scriptAst,
    isModule: true,
  };
  return findSsrCaller(ctx, source, owner, new Set(), 0);
}

function findSsrCaller(
  ctx: RuleContext,
  source: Source,
  owner: Owner,
  visited: Set<string>,
  depth: number,
): SsrCaller | null {
  const key = `${source.file}#${owner.name}`;
  if (visited.has(key) || depth > MAX_DEPTH) return null;
  visited.add(key);
  for (const call of callsOf(source.program, owner.name)) {
    const found = ssrCallSite(ctx, source, call, visited, depth);
    if (found) return found;
  }
  if (!owner.exported || !source.isModule) return null;
  const root = sourceRoot(ctx, source.file);
  const autoImported = AUTO_IMPORTED_PATH.test(relative(root, source.file));
  const mentions = new RegExp(`(?<![\\w$])${owner.name.replace(/\$/g, "\\$")}(?![\\w$])`);
  for (const file of sourceFiles(ctx, root)) {
    if (file === source.file) continue;
    const text = ctx.fs.readText(file);
    if (!text || !mentions.test(text)) continue;
    const caller = parsedSource(ctx, file, text);
    if (!caller) continue;
    const local = importedName(caller.program, owner.name, file, source.file);
    const name =
      local ?? (autoImported && !declares(caller.program, owner.name) ? owner.name : null);
    if (!name) continue;
    for (const call of callsOf(caller.program, name)) {
      const found = ssrCallSite(ctx, caller, call, visited, depth);
      if (found) return found;
    }
  }
  return null;
}

function ssrCallSite(
  ctx: RuleContext,
  source: Source,
  call: AnyNode,
  visited: Set<string>,
  depth: number,
): SsrCaller | null {
  if (isClientOnlyPath(source.file)) return null;
  if (ctx.helpers.isClientOnlyExecutionContext(call, source.text)) return null;
  const site = () => ({
    file: source.file,
    line: source.text.slice(0, call.start).split("\n").length,
    callee: call.callee.name,
    range: {
      start: call.start,
      end: call.end,
      line: source.text.slice(0, call.start).split("\n").length,
      column: call.start - source.text.lastIndexOf("\n", call.start - 1),
    },
  });
  const fn = nearestFunctionOrProgram(call.__doctorParent);
  if (!fn) return null;
  if (fn.type === "Program") return site();
  const parent = fn.__doctorParent;
  if (
    parent?.type === "CallExpression" &&
    parent.callee?.type === "Identifier" &&
    SSR_CALLBACK_CALLEES.has(parent.callee.name)
  )
    return site();
  const owner = topLevelFunction(fn);
  if (!owner) return null;
  if (isComposableName(owner.name)) return site();
  return findSsrCaller(ctx, source, owner, visited, depth + 1);
}

function topLevelFunction(fn: AnyNode): Owner | null {
  let declaration = fn;
  let name: string | undefined;
  if (fn.type === "FunctionDeclaration") name = fn.id?.name;
  else if (fn.type === "ArrowFunctionExpression" || fn.type === "FunctionExpression") {
    const declarator = fn.__doctorParent;
    if (declarator?.type !== "VariableDeclarator" || declarator.id?.type !== "Identifier")
      return null;
    declaration = declarator.__doctorParent;
    if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") return null;
    name = declarator.id.name;
  }
  if (!name) return null;
  const parent = declaration.__doctorParent;
  if (parent?.type === "Program")
    return {
      name,
      exported: parent.body.some(
        (statement: AnyNode) =>
          statement.type === "ExportNamedDeclaration" &&
          !statement.source &&
          statement.specifiers?.some((specifier: AnyNode) => specifier.local?.name === name),
      ),
    };
  if (parent?.type === "ExportNamedDeclaration" && parent.__doctorParent?.type === "Program")
    return { name, exported: true };
  return null;
}

function isComposableName(name: string) {
  return /^use[A-Z0-9]/.test(name);
}

function callsOf(program: AnyNode, name: string): AnyNode[] {
  const calls: AnyNode[] = [];
  const evidence = createLocalEvidence(program);
  const declarations = (program.body ?? []).flatMap((statement: AnyNode) => {
    const declaration = statement.declaration ?? statement;
    if (declaration.type === "ImportDeclaration")
      return declaration.specifiers.map((item: AnyNode) => item.local);
    if (declaration.type === "VariableDeclaration")
      return declaration.declarations.map((item: AnyNode) => item.id);
    return [declaration.id];
  });
  const target = declarations.find((declaration: AnyNode) => declaration?.name === name);
  walk(program, (node) => {
    if (
      node.type !== "CallExpression" ||
      node.callee?.type !== "Identifier" ||
      node.callee.name !== name
    )
      return;
    const binding = evidence.binding(node.callee);
    if (target ? binding && binding.node === target && !binding.written : !binding)
      calls.push(node);
  });
  return calls;
}

function importedName(program: AnyNode, name: string, from: string, target: string): string | null {
  for (const statement of program.body ?? []) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
    if (!resolvesTo(String(statement.source?.value ?? ""), from, target)) continue;
    for (const specifier of statement.specifiers ?? []) {
      if (
        specifier.type === "ImportSpecifier" &&
        specifier.importKind !== "type" &&
        (specifier.imported?.name ?? specifier.imported?.value) === name
      )
        return specifier.local.name;
    }
  }
  return null;
}

function declares(program: AnyNode, name: string): boolean {
  let found = false;
  walk(program, (node) => {
    if (found) return;
    if (
      (node.type === "VariableDeclarator" ||
        node.type === "FunctionDeclaration" ||
        node.type === "ImportSpecifier" ||
        node.type === "ImportDefaultSpecifier" ||
        node.type === "ImportNamespaceSpecifier") &&
      (node.id ?? node.local)?.name === name
    )
      found = true;
  });
  return found;
}

function resolvesTo(specifier: string, from: string, target: string): boolean {
  const targetPath = withoutExtension(target);
  const candidates = [targetPath, targetPath.replace(/\/index$/, "")];
  if (specifier.startsWith(".")) {
    const resolved = withoutExtension(resolve(dirname(from), specifier));
    return candidates.includes(resolved);
  }
  const alias = /^(?:~~|@@|~|@)\/(.+)$/.exec(specifier);
  if (!alias) return false;
  const rest = withoutExtension(alias[1]!);
  return candidates.some((candidate) => candidate.endsWith(`/${rest}`));
}

function withoutExtension(path: string) {
  return path.replace(/\.[cm]?[jt]sx?$/, "");
}

/**
 * Where callers of `file` live: the nearest Nuxt app or package around it. Doctor resolves relative
 * imports, Nuxt aliases, and auto-imports, which all stay inside one app or package.
 */
function sourceRoot(ctx: RuleContext, file: string): string {
  const projectRoot = resolve(ctx.project.root);
  let dir = dirname(resolve(projectRoot, file));
  while (dir.startsWith(projectRoot) && dir !== projectRoot) {
    if ([...NUXT_CONFIGS, "package.json"].some((name) => ctx.fs.exists(join(dir, name))))
      return dir;
    dir = dirname(dir);
  }
  return projectRoot;
}

function sourceFiles(ctx: RuleContext, root: string): string[] {
  const key = `nuxt:browser-global-callers:files:${root}`;
  let files = ctx.cache.get<string[]>(key);
  if (!files) {
    files = ctx.fs.glob(SOURCE_GLOB, { cwd: root, exclude: SOURCE_EXCLUDE }).sort();
    ctx.cache.set(key, files);
  }
  return files;
}

function parsedSource(ctx: RuleContext, file: string, text: string): Source | null {
  const key = `nuxt:browser-global-callers:source:${file}`;
  const cached = ctx.cache.get<Source | null>(key);
  if (cached !== undefined) return cached;
  const isModule = !file.endsWith(".vue");
  const scriptText = isModule ? text : sfcScriptText(text);
  const program = scriptText ? parseScript(isModule ? file : `${file}.tsx`, scriptText) : null;
  const source = program ? { file, text, program: withParents(program), isModule } : null;
  ctx.cache.set(key, source);
  return source;
}

/** The SFC's script blocks with everything else blanked, so script offsets are SFC offsets. */
function sfcScriptText(text: string): string | null {
  let masked = "";
  let last = 0;
  for (const match of text.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/g)) {
    const start = match.index + match[1]!.length;
    masked += text.slice(last, start).replace(/[^\n]/g, " ") + match[2];
    last = start + match[2]!.length;
  }
  return last ? masked : null;
}

function withParents(program: AnyNode): AnyNode {
  const visit = (node: AnyNode) => {
    for (const key of getNodeVisitorKeys(node)) {
      const value = node[key];
      for (const child of Array.isArray(value) ? value : [value]) {
        if (!child || typeof child.type !== "string") continue;
        Object.defineProperty(child, "__doctorParent", {
          value: node,
          configurable: true,
          enumerable: false,
        });
        visit(child);
      }
    }
  };
  visit(program);
  return program;
}

function walk(node: AnyNode, visit: (node: AnyNode) => void) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const key of getNodeVisitorKeys(node)) {
    const value = node[key];
    for (const child of Array.isArray(value) ? value : [value]) walk(child, visit);
  }
}
