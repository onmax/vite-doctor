import type { RuleContext } from "../../../core/index.js";
import {
  type AnyNode,
  createRule,
  nearestFunctionOrProgram,
  report,
  walkScriptLocal,
} from "./shared.js";
import { nitroServerFile } from "./server-layout.js";

const RULE_ID = "nitro/cache/no-module-scope-response-cache";
const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);
const BLOCK_TYPES = new Set([
  "BlockStatement",
  "ForStatement",
  "ForOfStatement",
  "ForInStatement",
  "SwitchCase",
  "StaticBlock",
]);
const WRAPPERS = new Set([
  "ChainExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "ParenthesizedExpression",
]);
const RELATIONAL = new Set(["<", "<=", ">", ">="]);
const CLOCK_CALLS = new Set(["Date.now", "performance.now"]);
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__)\/|\.(?:spec|test)\.[cm]?[jt]sx?$/;

interface CacheBinding {
  name: string;
  kind: "variable" | "map";
  declarator: AnyNode;
  reads: boolean;
  writes: boolean;
  expires: boolean;
}

export const noModuleScopeResponseCache = createRule({
  meta: {
    id: RULE_ID,
    title: "Cache upstream responses with defineCachedFunction",
    category: "cache",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://nitro.build/docs/cache",
    requires: { script: true, nitro: true },
  },
  create(ctx) {
    if (!/\b(?:Date|performance)\.now\b|\.getTime\b/.test(ctx.file.text)) return;
    if (!isServerRuntimeFile(ctx)) return;
    return {
      Program(program: AnyNode) {
        const bindings = moduleBindings(program);
        if (!bindings.size) return;
        const helpers = cacheHelpers(program);
        walkScriptLocal(program, (node) => {
          if (node.type !== "Identifier") return;
          const binding = bindings.get(node.name);
          if (!binding || node === binding.declarator.id) return;
          const owner = nearestFunctionOrProgram(node);
          if (!owner || owner.type === "Program" || !resolvesToModuleBinding(node, node.name))
            return;
          const access = bindingAccess(node, binding, helpers);
          binding.reads ||= access.reads;
          // Filling the cache from async code is what makes it a response cache rather than,
          // say, a synchronous rate-limit window.
          binding.writes ||= access.writes && isAsyncCode(owner);
          binding.expires ||=
            access.expires || comparesWithClock(owner, (item) => cachedEntryOf(item, [node]));
        });
        for (const binding of bindings.values()) {
          if (!binding.reads || !binding.writes || !binding.expires) continue;
          report(
            ctx,
            binding.declarator.id,
            RULE_ID,
            "warn",
            "cache",
            `${binding.name} is a hand-rolled TTL cache at module scope. It lives in one server instance or isolate, grows with every new key, cannot be invalidated through Nitro's cache storage, and hands the stored value to every later caller with the same key, including values that a request-scoped (user-authorized) client fetched.`,
            "Wrap the upstream call in defineCachedFunction() with a maxAge and a getKey that covers every input that changes the response, including the user or tenant when the upstream client is authorized per request. If the cached value cannot be serialized to cache storage, such as compiled validators, keep it in memory and suppress this diagnostic with the reason.",
          );
        }
      },
    };
  },
});

function isServerRuntimeFile(ctx: RuleContext) {
  const path = ctx.file.relativePath.replace(/\\/g, "/");
  if (TEST_FILE.test(path) || /\.d\.[cm]?ts$/.test(path)) return false;
  return Boolean(nitroServerFile(ctx, ctx.file.path)) && !/\.config\.[cm]?[jt]s$/.test(path);
}

function moduleBindings(program: AnyNode) {
  const bindings = new Map<string, CacheBinding>();
  for (const statement of program.body ?? []) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const declarator of declaration.declarations) {
      if (declarator.id?.type !== "Identifier") continue;
      const kind = isNew(declarator.init, "Map")
        ? "map"
        : declaration.kind === "const"
          ? null
          : "variable";
      if (!kind) continue;
      bindings.set(declarator.id.name, {
        name: declarator.id.name,
        kind,
        declarator,
        reads: false,
        writes: false,
        expires: false,
      });
    }
  }
  return bindings;
}

interface CacheHelper {
  reads: Set<number>;
  writes: Set<number>;
  expires: Set<number>;
}

// Caches often go through small read/write helpers that take the Map as a parameter.
function cacheHelpers(program: AnyNode) {
  const helpers = new Map<string, CacheHelper>();
  for (const statement of program.body ?? []) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    const fn =
      declaration?.type === "FunctionDeclaration"
        ? declaration
        : declaration?.type === "VariableDeclaration" &&
            declaration.declarations.length === 1 &&
            FUNCTION_TYPES.has(unwrap(declaration.declarations[0].init)?.type)
          ? unwrap(declaration.declarations[0].init)
          : null;
    const name =
      declaration?.type === "FunctionDeclaration"
        ? declaration.id?.name
        : declaration?.declarations?.[0]?.id?.name;
    if (!fn || !name) continue;
    const helper: CacheHelper = { reads: new Set(), writes: new Set(), expires: new Set() };
    fn.params.forEach((param: AnyNode, index: number) => {
      if (param.type !== "Identifier") return;
      const references: AnyNode[] = [];
      walkScriptLocal(fn.body, (node) => {
        if (node.type === "Identifier" && node.name === param.name && isValueReference(node))
          references.push(node);
      });
      for (const reference of references) {
        const method = mapMethod(reference);
        if (method === "get" || method === "has") helper.reads.add(index);
        if (method === "set") helper.writes.add(index);
      }
      if (references.length && comparesWithClock(fn, (node) => cachedEntryOf(node, references)))
        helper.expires.add(index);
    });
    if (helper.reads.size || helper.writes.size) helpers.set(name, helper);
  }
  return helpers;
}

function bindingAccess(node: AnyNode, binding: CacheBinding, helpers: Map<string, CacheHelper>) {
  const access = { reads: false, writes: false, expires: false };
  const parent = node.__doctorParent;
  if (binding.kind === "variable") {
    if (parent?.type === "AssignmentExpression" && parent.left === node) access.writes = true;
    else access.reads = isValueReference(node);
    return access;
  }
  const method = mapMethod(node);
  if (method === "get" || method === "has") access.reads = true;
  if (method === "set") access.writes = true;
  if (parent?.type === "CallExpression" && parent.callee?.type === "Identifier") {
    const helper = helpers.get(parent.callee.name);
    const index = parent.arguments.indexOf(node);
    if (helper && index >= 0) {
      access.reads = helper.reads.has(index);
      access.writes = helper.writes.has(index);
      access.expires = helper.expires.has(index);
    }
  }
  return access;
}

// The function, or a function it is nested in, is async or a promise continuation.
function isAsyncCode(fn: AnyNode) {
  for (let current = fn; current; current = current.__doctorParent) {
    if (!FUNCTION_TYPES.has(current.type)) continue;
    if (current.async) return true;
    const call = current.__doctorParent;
    const callee = call?.type === "CallExpression" ? unwrap(call.callee) : null;
    if (
      callee?.type === "MemberExpression" &&
      call.arguments.includes(current) &&
      ["then", "catch", "finally"].includes(callee.property?.name)
    )
      return true;
  }
  return false;
}

function mapMethod(node: AnyNode) {
  const member = node.__doctorParent;
  if (member?.type !== "MemberExpression" || member.object !== node || member.computed) return null;
  const call = member.__doctorParent;
  if (call?.type !== "CallExpression" || call.callee !== member) return null;
  return member.property?.name ?? null;
}

// The entry read from the cache, such as `cached` in `const cached = cache.get(key)`.
function cachedEntryOf(node: AnyNode, references: AnyNode[]) {
  if (references.includes(node)) return true;
  if (node.type !== "Identifier") return false;
  return references.some((reference) => {
    const call = reference.__doctorParent?.__doctorParent;
    const declarator = call?.__doctorParent;
    return (
      declarator?.type === "VariableDeclarator" &&
      unwrap(declarator.init) === call &&
      declarator.id?.type === "Identifier" &&
      declarator.id.name === node.name
    );
  });
}

// A relational comparison between a clock reading and a value derived from the cache, such as
// `cached.expiresAt > Date.now()`, in the function that owns the cache access.
function comparesWithClock(fn: AnyNode, isCacheValue: (node: AnyNode) => boolean) {
  return clockComparisons(fn).some((side) =>
    mentions(side, (node) => isCacheValue(node) && readsEntryField(node)),
  );
}

// `entry.expiresAt`, not `lastCall` or `hits.get(ip)`: the expiry is a field of the cached entry.
function readsEntryField(node: AnyNode) {
  let current = node;
  while (current.__doctorParent && WRAPPERS.has(current.__doctorParent.type))
    current = current.__doctorParent;
  const member = current.__doctorParent;
  if (member?.type !== "MemberExpression" || member.object !== current) return false;
  if (member.property?.name === "get" && member.__doctorParent?.callee === member)
    return readsEntryField(member.__doctorParent);
  return !["get", "has", "size"].includes(member.property?.name);
}

const comparisonsByFunction = new WeakMap<object, AnyNode[]>();

function clockComparisons(fn: AnyNode): AnyNode[] {
  let sides = comparisonsByFunction.get(fn);
  if (sides) return sides;
  const found: AnyNode[] = [];
  const clocks = clockLocals(fn);
  walkScriptLocal(fn.body, (node) => {
    if (node.type !== "BinaryExpression" || !RELATIONAL.has(node.operator)) return;
    if (readsClock(node.left, clocks)) found.push(node.right);
    else if (readsClock(node.right, clocks)) found.push(node.left);
  });
  comparisonsByFunction.set(fn, found);
  return found;
}

function clockLocals(fn: AnyNode) {
  const names = new Set<string>();
  walkScriptLocal(fn.body, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id?.type === "Identifier" &&
      readsClock(node.init, names)
    )
      names.add(node.id.name);
  });
  return names;
}

function readsClock(node: AnyNode, locals: Set<string>) {
  return mentions(node, (item) => {
    if (item.type === "Identifier" && locals.has(item.name) && isValueReference(item)) return true;
    if (item.type !== "CallExpression") return false;
    const callee = unwrap(item.callee);
    if (CLOCK_CALLS.has(memberName(callee))) return true;
    return memberName(callee) === "getTime" && isNew(callee.object, "Date");
  });
}

function mentions(node: AnyNode, predicate: (node: AnyNode) => boolean) {
  let found = false;
  walkScriptLocal(node, (item) => {
    if (!found && predicate(item)) found = true;
  });
  return found;
}

function resolvesToModuleBinding(node: AnyNode, name: string) {
  for (let current = node.__doctorParent; current; current = current.__doctorParent) {
    if (current.type === "Program") return true;
    if (FUNCTION_TYPES.has(current.type)) {
      if (current.id?.name === name && current.type === "FunctionExpression") return false;
      if (current.params?.some((param: AnyNode) => bindsName(param, name))) return false;
      if (declaresVar(current.body, name)) return false;
    } else if (BLOCK_TYPES.has(current.type) || current.type === "CatchClause") {
      if (current.type === "CatchClause" && bindsName(current.param, name)) return false;
      const statements =
        current.type === "BlockStatement" || current.type === "StaticBlock"
          ? current.body
          : current.type === "SwitchCase"
            ? current.consequent
            : [current.init ?? current.left];
      if (statements.some((statement: AnyNode) => declaresLexical(statement, name))) return false;
    }
  }
  return false;
}

function declaresLexical(statement: AnyNode, name: string): boolean {
  if (!statement) return false;
  if (statement.type === "VariableDeclaration")
    return statement.declarations.some((item: AnyNode) => bindsName(item.id, name));
  return (
    (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") &&
    statement.id?.name === name
  );
}

function declaresVar(body: AnyNode, name: string) {
  let found = false;
  walkScriptLocal(body, (node) => {
    if (found || node.type !== "VariableDeclaration" || node.kind !== "var") return;
    if (nearestFunctionOrProgram(node) !== body.__doctorParent) return;
    found = node.declarations.some((item: AnyNode) => bindsName(item.id, name));
  });
  return found;
}

function bindsName(pattern: AnyNode, name: string): boolean {
  if (!pattern) return false;
  if (pattern.type === "Identifier") return pattern.name === name;
  if (pattern.type === "AssignmentPattern") return bindsName(pattern.left, name);
  if (pattern.type === "RestElement") return bindsName(pattern.argument, name);
  if (pattern.type === "ArrayPattern")
    return pattern.elements.some((item: AnyNode) => bindsName(item, name));
  if (pattern.type === "ObjectPattern")
    return pattern.properties.some((item: AnyNode) => bindsName(item.value ?? item.argument, name));
  if (pattern.type === "TSParameterProperty") return bindsName(pattern.parameter, name);
  return false;
}

function isValueReference(node: AnyNode) {
  const parent = node.__doctorParent;
  if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed)
    return false;
  if (parent?.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand)
    return false;
  return !(parent?.type === "VariableDeclarator" && parent.id === node);
}

function memberName(node: AnyNode): string {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "MemberExpression" && !node.computed)
    return node.object?.type === "Identifier"
      ? `${node.object.name}.${node.property?.name}`
      : (node.property?.name ?? "");
  return "";
}

function isNew(node: AnyNode, name: string) {
  const value = unwrap(node);
  return (
    value?.type === "NewExpression" &&
    value.callee?.type === "Identifier" &&
    value.callee.name === name
  );
}

function unwrap(node: AnyNode): AnyNode {
  while (node && WRAPPERS.has(node.type)) node = node.expression;
  return node;
}
