import type { RuleContext } from "../../../../core/index.js";
import {
  type AnyNode,
  createRule,
  hasPriorServerReturnGuard,
  isClientOnlyPath,
  isRuntimeAppFile,
  nearestFunctionOrProgram,
  report,
  walkScriptLocal,
} from "./shared.js";
import { findFunctionVar, findStatementBinding, patternNames } from "./script-index.js";

const RULE_ID = "nuxt/ssr/no-module-scope-request-state";
const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);
const SCOPE_TYPES = new Set([
  "BlockStatement",
  "ForStatement",
  "ForOfStatement",
  "ForInStatement",
  "SwitchStatement",
]);
const WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "ParenthesizedExpression",
]);
const REQUEST_CALLS = new Set([
  "$fetch",
  "fetch",
  "useFetch",
  "useLazyFetch",
  "useAsyncData",
  "useLazyAsyncData",
  "useRequestFetch",
  "useRequestEvent",
  "useRequestHeaders",
  "useRequestHeader",
  "useRequestURL",
  "useCookie",
  "useNuxtApp",
  "useRoute",
  "useRouter",
  "useState",
  "useUserSession",
]);
const PROMISE_COMBINATORS = new Set([
  "Promise.all",
  "Promise.allSettled",
  "Promise.any",
  "Promise.race",
]);
const PROMISE_METHODS = new Set(["then", "catch", "finally"]);

interface Range {
  start: number;
  end: number;
}

interface ModuleBinding {
  name: string;
  kind: "variable" | "collection";
  declarator: AnyNode;
}

export const noModuleScopeRequestState = createRule({
  meta: {
    id: RULE_ID,
    title: "Keep request state out of module scope",
    category: "ssr",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/getting-started/state-management#best-practices",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!/\b(?:let|var)\b|new\s+(?:Map|Set)\b/.test(ctx.file.text)) return;
    if (isClientOnlyPath(ctx.file.relativePath) || !isRuntimeAppFile(ctx)) return;
    return {
      Program(program: AnyNode) {
        const bindings = moduleBindings(ctx, program);
        if (!bindings.size) return;
        const setup = blockRange(ctx, "scriptSetup");
        const reported = new Set<string>();
        walkScriptLocal(program, (node) => {
          if (node.type !== "Identifier") return;
          const binding = bindings.get(node.name);
          if (!binding || reported.has(binding.name)) return;
          const value = writtenValue(node, binding);
          if (!value || !isRequestTimeWrite(ctx, node, setup)) return;
          if (!resolvesToModuleBinding(node, binding.name)) return;
          if (!isRequestScopedValue(value, setup, 0)) return;
          reported.add(binding.name);
          const line = ctx.range(node)?.line;
          report(
            ctx,
            binding.declarator.id,
            RULE_ID,
            "warn",
            "ssr",
            `${binding.name} lives at module scope and request-time code${line ? ` on line ${line}` : ""} stores request data in it. On the server every SSR request shares this module, so concurrent requests read and overwrite each other's value.`,
            "Keep per-request state in useState() or the Pinia store state, or key it by the Nuxt app with a WeakMap<NuxtApp, ...> so each SSR request gets its own value.",
          );
        });
      },
    };
  },
});

function moduleBindings(ctx: RuleContext, program: AnyNode) {
  const bindings = new Map<string, ModuleBinding>();
  const moduleScript = ctx.file.relativePath.endsWith(".vue")
    ? blockRange(ctx, "script")
    : { start: 0, end: Infinity };
  if (!moduleScript) return bindings;
  for (const statement of program.body ?? []) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type !== "VariableDeclaration") continue;
    if (statement.start < moduleScript.start || statement.end > moduleScript.end) continue;
    for (const declarator of declaration.declarations) {
      if (declarator.id?.type !== "Identifier") continue;
      if (declaration.kind === "let" || declaration.kind === "var")
        bindings.set(declarator.id.name, {
          name: declarator.id.name,
          kind: "variable",
          declarator,
        });
      else if (isCollectionConstruction(declarator.init))
        bindings.set(declarator.id.name, {
          name: declarator.id.name,
          kind: "collection",
          declarator,
        });
    }
  }
  return bindings;
}

// `<script setup>` bindings belong to one component instance and its top level runs on every
// render; only a plain `<script>` block is evaluated once per module.
function blockRange(ctx: RuleContext, block: "script" | "scriptSetup"): Range | null {
  const loc = (ctx.sfc?.descriptor as AnyNode)?.[block]?.loc;
  return loc ? { start: loc.start.offset, end: loc.end.offset } : null;
}

function inRange(node: AnyNode, range: Range | null) {
  return Boolean(range && node.start >= range.start && node.end <= range.end);
}

function isCollectionConstruction(init: AnyNode) {
  const node = unwrap(init);
  return (
    node?.type === "NewExpression" &&
    node.callee?.type === "Identifier" &&
    (node.callee.name === "Map" || node.callee.name === "Set")
  );
}

function writtenValue(node: AnyNode, binding: ModuleBinding): AnyNode {
  const parent = node.__doctorParent;
  if (binding.kind === "variable") {
    if (parent?.type === "AssignmentExpression" && parent.left === node) return parent.right;
    return null;
  }
  if (parent?.type !== "MemberExpression" || parent.object !== node || parent.computed) return null;
  const call = parent.__doctorParent;
  if (call?.type !== "CallExpression" || call.callee !== parent) return null;
  const method = parent.property?.name;
  if (method === "set") return call.arguments?.[1] ?? null;
  if (method === "add") return call.arguments?.[0] ?? null;
  return null;
}

function isRequestTimeWrite(ctx: RuleContext, node: AnyNode, setup: Range | null) {
  if (nearestFunctionOrProgram(node)?.type === "Program" && !inRange(node, setup)) return false;
  const guardText = ctx.file.text.slice(outermostFunction(node)?.start ?? 0, node.start);
  if (hasPriorServerReturnGuard(guardText, guardText.length)) return false;
  return !ctx.helpers.isClientOnlyExecutionContext(node, ctx.file.text);
}

// A server early return only guards code in the same top-level function, including callbacks
// that function registers.
function outermostFunction(node: AnyNode) {
  let outermost: AnyNode = null;
  for (let current = node.__doctorParent; current; current = current.__doctorParent)
    if (FUNCTION_TYPES.has(current.type)) outermost = current;
  return outermost;
}

function resolvesToModuleBinding(node: AnyNode, name: string) {
  for (let current = node.__doctorParent; current; current = current.__doctorParent) {
    if (current.type === "Program") return true;
    if (FUNCTION_TYPES.has(current.type)) {
      if (current.type === "FunctionExpression" && current.id?.name === name) return false;
      if (current.params?.some((param: AnyNode) => patternNames(param).includes(name)))
        return false;
      if (findFunctionVar(current.body, name)) return false;
    } else if (SCOPE_TYPES.has(current.type)) {
      if (findStatementBinding(current, name)) return false;
    } else if (current.type === "CatchClause") {
      if (patternNames(current.param).includes(name)) return false;
    }
  }
  return false;
}

// Values that only exist for one request: awaited or fetched data, in-flight promises, the
// current store (`this` in a Pinia action), and Nuxt request composables.
function isRequestScopedValue(value: AnyNode, setup: Range | null, depth: number): boolean {
  let scoped = false;
  const visit = (node: AnyNode) => {
    if (scoped || !node || typeof node !== "object") return;
    if (node.type === "ThisExpression" || node.type === "AwaitExpression") {
      scoped = true;
      return;
    }
    if (node.type === "CallExpression" && isRequestScopedCall(node)) {
      scoped = true;
      return;
    }
    if (node.type === "NewExpression" && node.callee?.name === "Promise") {
      scoped = true;
      return;
    }
    if (
      node.type === "Identifier" &&
      depth < 2 &&
      isRequestScopedLocal(node, setup, depth) &&
      !isPropertyKey(node)
    ) {
      scoped = true;
      return;
    }
    if (FUNCTION_TYPES.has(node.type) && !isInvoked(node)) return;
    for (const [key, child] of Object.entries(node) as [string, AnyNode][]) {
      if (key === "__doctorParent" || key === "parent" || key === "typeAnnotation") continue;
      if (Array.isArray(child)) child.forEach(visit);
      else if (typeof child?.type === "string") visit(child);
    }
  };
  visit(value);
  return scoped;
}

function isRequestScopedCall(node: AnyNode) {
  const callee = unwrap(node.callee);
  if (FUNCTION_TYPES.has(callee?.type) && callee.async) return true;
  const name = calleeName(callee);
  if (!name) return false;
  if (REQUEST_CALLS.has(name) || PROMISE_COMBINATORS.has(name)) return true;
  if (/^use[A-Z]\w*Store$/.test(name)) return true;
  if (name.startsWith("$") || name.includes(".$")) return true;
  const method = name.split(".").at(-1)!;
  return name.includes(".") && PROMISE_METHODS.has(method);
}

function isRequestScopedLocal(node: AnyNode, setup: Range | null, depth: number) {
  const parent = node.__doctorParent;
  if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed)
    return false;
  for (let current = parent; current; current = current.__doctorParent) {
    const declarator =
      current.type === "Program"
        ? setupBinding(current, node.name, setup)
        : SCOPE_TYPES.has(current.type)
          ? findStatementBinding(current, node.name)
          : FUNCTION_TYPES.has(current.type)
            ? findFunctionVar(current.body, node.name)
            : null;
    if (declarator?.type === "VariableDeclarator")
      return Boolean(declarator.init) && isRequestScopedValue(declarator.init, setup, depth + 1);
    if (declarator) return false;
  }
  return false;
}

function setupBinding(program: AnyNode, name: string, setup: Range | null) {
  const binding = findStatementBinding(program, name);
  return binding && inRange(binding, setup) ? binding : null;
}

function isInvoked(node: AnyNode) {
  let parent = node.__doctorParent;
  while (parent && WRAPPERS.has(parent.type)) parent = parent.__doctorParent;
  return parent?.type === "CallExpression" && unwrap(parent.callee) === node;
}

function isPropertyKey(node: AnyNode) {
  const parent = node.__doctorParent;
  return parent?.type === "Property" && parent.key === node && !parent.computed;
}

function calleeName(node: AnyNode): string | null {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "MemberExpression" && !node.computed) {
    const object =
      node.object?.type === "ThisExpression" ? "this" : calleeName(unwrap(node.object));
    if (node.object?.type === "CallExpression")
      return `${calleeName(unwrap(node.object.callee)) ?? ""}().${node.property?.name}`;
    return object ? `${object}.${node.property?.name}` : `.${node.property?.name}`;
  }
  return null;
}

function unwrap(node: AnyNode): AnyNode {
  while (node && WRAPPERS.has(node.type)) node = node.expression;
  return node;
}
