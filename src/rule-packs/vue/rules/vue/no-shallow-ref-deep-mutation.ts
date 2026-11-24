import type { SFCDescriptor } from "@vue/compiler-sfc";
import type { RuleContext } from "../../../../core/index.js";
import { scriptMayName, type ScopeVariable } from "../../../../core/internal/script-scope.js";
import { AnyNode, createRule, namePattern, report } from "./shared.js";
import { renderTemplateReads, templateWrites } from "./template-reads.js";
import {
  constBinding,
  indexedScript,
  memberName,
  unwrapTs,
  valueParent,
  vueApiCall,
  type IndexedScript,
} from "./vue-api.js";

const RULE_ID = "vue/reactivity/no-shallow-ref-deep-mutation";
const SHALLOW_REF = new Set(["shallowRef"]);
const TRIGGER_REF = new Set(["triggerRef"]);
const REACTIVE_READERS = new Set([
  "computed",
  "watch",
  "watchEffect",
  "watchPostEffect",
  "watchSyncEffect",
]);
/** Vue APIs that call a function argument after setup has returned and the first render ran. */
const LATER_VUE_CALLBACKS = new Set([
  "onMounted",
  "onUpdated",
  "onActivated",
  "onDeactivated",
  "nextTick",
  "watch",
  "watchEffect",
  "watchPostEffect",
  "watchSyncEffect",
]);
const LATER_GLOBALS = new Set([
  "setTimeout",
  "setInterval",
  "requestAnimationFrame",
  "requestIdleCallback",
  "queueMicrotask",
]);
const LATER_METHODS = new Set(["then", "catch", "finally", "addEventListener"]);
const ARRAY_MUTATORS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
]);
const MAP_MUTATORS = new Set(["set", "delete", "clear"]);
const SET_MUTATORS = new Set(["add", "delete", "clear"]);
const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

interface DeepMutation {
  node: AnyNode;
  ref: string;
  target: string;
}

/**
 * `shallowRef()` only tracks `.value` itself. Changing something inside `.value` notifies nobody,
 * so templates, computeds, and watchers that read the ref keep showing the old contents.
 */
export const noShallowRefDeepMutation = createRule({
  meta: {
    id: RULE_ID,
    title: "Trigger a shallowRef after mutating its value",
    category: "reactivity",
    severity: "error",
    confidence: "heuristic-high",
    fixable: "suggestion",
    docsUrl: "https://vuejs.org/api/reactivity-advanced.html#shallowref",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    if (!scriptMayName(ctx, namePattern([...SHALLOW_REF]))) return;
    return {
      Program() {
        for (const mutation of deepMutations(ctx)) {
          report(
            ctx,
            mutation.node,
            RULE_ID,
            "error",
            "reactivity",
            `${mutation.ref} is a shallowRef(), which only tracks replacing ${mutation.ref}.value. This changes ${mutation.target} in place after setup, so Vue notifies nothing: the template, computed(), and watchers that read ${mutation.ref} keep the old contents until something else re-runs them.`,
            `Call triggerRef(${mutation.ref}) after the change, or assign a new object or array to ${mutation.ref}.value. Use ref() instead if ${mutation.ref} should track nested changes.`,
          );
        }
      },
    };
  },
});

function deepMutations(ctx: RuleContext): DeepMutation[] {
  const script = indexedScript(ctx);
  if (!script) return [];
  const result: DeepMutation[] = [];
  try {
    for (const call of script.nodes("CallExpression")) {
      if (!vueApiCall(script, call.callee, SHALLOW_REF)) continue;
      const [declarator, child] = valueParent(script, call);
      if (declarator?.type !== "VariableDeclarator" || declarator.init !== child) continue;
      const variable = constBinding(script, declarator);
      if (!variable) continue;
      const values = [call.arguments[0]];
      const mutations: Array<{ node: AnyNode; path: string[]; method?: string; target: AnyNode }> =
        [];
      const assignedIn = new Set<AnyNode>();
      const declarationOwner = script.owner(declarator);
      let readReactively = false;
      // A triggerRef() anywhere, or a use the rule cannot follow, may notify subscribers.
      let mayTrigger = false;
      for (const reference of variable.references) {
        if (reference.init) continue;
        const id = reference.identifier;
        const use = classifyUse(script, id);
        if (use.kind === "value-assignment") {
          values.push(use.value);
          assignedIn.add(script.owner(id));
        } else if (use.kind === "mutation") mutations.push(use);
        else if (use.kind === "watch-source") readReactively = true;
        else if (use.kind === "trigger" || use.kind === "other") mayTrigger = true;
        if (!readReactively && insideReactiveReader(script, id)) readReactively = true;
      }
      if (mayTrigger || !mutations.length) continue;
      const name = declarator.id.name;
      const descriptor = ctx.file.sfc?.descriptor as SFCDescriptor | undefined;
      const templateScope = !declarationOwner && !!descriptor?.scriptSetup;
      // The template can replace the value with one that is already reactive.
      if (templateScope && templateWrites(ctx).has(name)) continue;
      if (!readReactively && !(templateScope && renderTemplateReads(ctx).has(name))) continue;
      for (const mutation of mutations) {
        if (assignedIn.has(script.owner(mutation.node))) continue;
        if (!values.every((value) => mutatesPlainValue(script, value, mutation))) continue;
        if (!runsAfterSetup(script, mutation.node, declarationOwner)) continue;
        result.push({
          node: mutation.node,
          ref: name,
          target: ctx.file.text.slice(mutation.target.range[0], mutation.target.range[1]),
        });
      }
    }
  } catch {
    return [];
  }
  return result;
}

type Use =
  | { kind: "value-assignment"; value: AnyNode }
  | { kind: "mutation"; node: AnyNode; path: string[]; method?: string; target: AnyNode }
  | { kind: "trigger" | "watch-source" | "read" | "escape" | "other" };

/**
 * How one reference to the ref is used. Anything this rule cannot follow, such as passing the ref
 * to another function, is `other`, which keeps the rule quiet for that ref.
 */
function classifyUse(script: IndexedScript, id: AnyNode): Use {
  const [parent, child] = valueParent(script, id);
  if (parent?.type === "CallExpression" && parent.arguments.includes(child)) {
    const api = vueApiCall(script, parent.callee, new Set([...TRIGGER_REF, "watch"]));
    if (api === "triggerRef") return { kind: "trigger" };
    if (api === "watch" && parent.arguments[0] === child) return { kind: "watch-source" };
    return { kind: "other" };
  }
  if (parent?.type === "ArrayExpression") {
    const [call, element] = valueParent(script, parent);
    if (
      call?.type === "CallExpression" &&
      call.arguments[0] === element &&
      vueApiCall(script, call.callee, new Set(["watch"]))
    )
      return { kind: "watch-source" };
    return { kind: "other" };
  }
  if (isEscape(script, parent, child)) return { kind: "escape" };
  if (parent?.type !== "MemberExpression" || parent.object !== child) return { kind: "other" };
  if (memberName(parent) !== "value") return { kind: "other" };
  const value = parent;
  const [valueUse, valueChild] = valueParent(script, value);
  if (valueUse?.type === "AssignmentExpression" && valueUse.left === valueChild)
    return {
      kind: "value-assignment",
      value: valueUse.operator === "=" ? valueUse.right : undefined,
    };
  if (
    (valueUse?.type === "UpdateExpression" && valueUse.argument === valueChild) ||
    (valueUse?.type === "UnaryExpression" && valueUse.operator === "delete")
  )
    return { kind: "other" };
  return memberMutation(script, value) ?? { kind: "read" };
}

/** Returning or exporting the ref lets other code read it, but not replace what it holds. */
function isEscape(script: IndexedScript, parent: AnyNode, child: AnyNode): boolean {
  if (parent?.type === "ReturnStatement" || parent?.type === "ExportSpecifier") return true;
  if (parent?.type !== "Property" || parent.value !== child) return false;
  const object = script.parent(parent);
  const [owner] = valueParent(script, object);
  return owner?.type === "ReturnStatement";
}

/** A write inside `<ref>.value`: an assignment, `++`, `delete`, or a known collection mutator. */
function memberMutation(
  script: IndexedScript,
  value: AnyNode,
): Extract<Use, { kind: "mutation" }> | undefined {
  const path: string[] = [];
  let node = value;
  for (;;) {
    const [parent, child] = valueParent(script, node);
    if (parent?.type === "MemberExpression" && parent.object === child) {
      const name = memberName(parent);
      const [next, nextChild] = valueParent(script, parent);
      const written =
        (next?.type === "AssignmentExpression" && next.left === nextChild) ||
        (next?.type === "UpdateExpression" && next.argument === nextChild) ||
        (next?.type === "UnaryExpression" &&
          next.operator === "delete" &&
          next.argument === nextChild);
      if (written) return { kind: "mutation", node: next, path, target: parent };
      if (next?.type === "CallExpression" && next.callee === nextChild && name !== undefined)
        return { kind: "mutation", node: next, path, method: name, target: child };
      if (name === undefined) return undefined;
      path.push(name);
      node = parent;
      continue;
    }
    return undefined;
  }
}

/**
 * Whether the mutated object is a plain array, object, Map, or Set literal reached through `path`.
 * A value that could be reactive itself, such as `shallowRef(reactive({}))`, tracks its own
 * changes, so the rule stays quiet unless every value the ref is given is known to be plain.
 */
function mutatesPlainValue(
  script: IndexedScript,
  value: AnyNode,
  mutation: { path: string[]; method?: string },
): boolean {
  let node = unwrapTs(value);
  for (const key of mutation.path) {
    if (node?.type !== "ObjectExpression") return false;
    let found: AnyNode;
    for (const property of node.properties) {
      if (property.type !== "Property" || property.kind !== "init") return false;
      const name = property.computed ? undefined : (property.key.name ?? property.key.value);
      if (name === undefined) return false;
      if (String(name) === key) found = property.value;
    }
    node = unwrapTs(found);
  }
  const kind = plainKind(script, node);
  if (!mutation.method) return kind === "object" || kind === "array";
  return (
    (kind === "array" && ARRAY_MUTATORS.has(mutation.method)) ||
    (kind === "map" && MAP_MUTATORS.has(mutation.method)) ||
    (kind === "set" && SET_MUTATORS.has(mutation.method))
  );
}

function plainKind(script: IndexedScript, node: AnyNode): string | undefined {
  if (node?.type === "ObjectExpression") {
    return node.properties.every((property: AnyNode) => property.type === "Property")
      ? "object"
      : undefined;
  }
  if (node?.type === "ArrayExpression") return "array";
  if (node?.type !== "NewExpression" || node.callee?.type !== "Identifier") return undefined;
  if (script.references.get(node.callee)?.resolved) return undefined;
  return { Map: "map", Set: "set", Array: "array" }[node.callee.name as string];
}

/** Whether `id` is read inside a computed() getter or a watcher's source or effect. */
function insideReactiveReader(script: IndexedScript, id: AnyNode): boolean {
  for (let fn = script.owner(id); fn; fn = script.owner(fn)) {
    const [call, child] = valueParent(script, fn);
    if (call?.type !== "CallExpression") continue;
    if (!vueApiCall(script, call.callee, REACTIVE_READERS)) continue;
    if (call.arguments[0] === child) return true;
  }
  return false;
}

/**
 * Whether the mutation runs after setup returned, when something may already have read the ref.
 * Code that runs while setup runs changes the value before the first render reads it.
 */
function runsAfterSetup(script: IndexedScript, node: AnyNode, declarationOwner: AnyNode): boolean {
  return laterPath(script, node, declarationOwner, new Set());
}

function laterPath(
  script: IndexedScript,
  node: AnyNode,
  declarationOwner: AnyNode,
  seen: Set<AnyNode>,
): boolean {
  for (let fn = script.owner(node); fn && fn !== declarationOwner; fn = script.owner(fn)) {
    if (runsLater(script, fn, node, declarationOwner, seen)) return true;
  }
  return false;
}

function runsLater(
  script: IndexedScript,
  fn: AnyNode,
  at: AnyNode,
  declarationOwner: AnyNode,
  seen: Set<AnyNode>,
): boolean {
  if (fn.async && awaitsBefore(script, fn, at)) return true;
  const [parent, child] = valueParent(script, fn);
  if (parent?.type === "CallExpression" && parent.arguments.includes(child))
    return callsLater(script, parent, child);
  const binding = functionBinding(script, fn, parent);
  if (!binding || seen.has(fn)) return false;
  seen.add(fn);
  for (const reference of binding.references) {
    if (reference.init) continue;
    const [use, used] = valueParent(script, reference.identifier);
    if (use?.type === "CallExpression" && use.callee === used) {
      if (!laterPath(script, use, declarationOwner, seen)) return false;
    } else if (use?.type === "CallExpression" && use.arguments.includes(used)) {
      if (!callsLater(script, use, used)) return false;
    } else if (!isHandlerUse(script, use, used)) return false;
  }
  return true;
}

function awaitsBefore(script: IndexedScript, fn: AnyNode, at: AnyNode): boolean {
  return script
    .nodes("AwaitExpression")
    .some((node) => script.owner(node) === fn && node.range[1] <= at.range[0]);
}

/** Whether `call` runs its function argument `argument` later, as a hook, timer, or listener. */
function callsLater(script: IndexedScript, call: AnyNode, argument: AnyNode): boolean {
  const api = vueApiCall(script, call.callee, LATER_VUE_CALLBACKS);
  if (api) return api === "watch" ? call.arguments[1] === argument : true;
  const callee = unwrapTs(call.callee);
  if (callee?.type === "Identifier")
    return LATER_GLOBALS.has(callee.name) && !script.references.get(callee)?.resolved;
  const method = memberName(callee);
  if (method === "addEventListener") return call.arguments[1] === argument;
  return !!method && LATER_METHODS.has(method);
}

function functionBinding(
  script: IndexedScript,
  fn: AnyNode,
  parent: AnyNode,
): ScopeVariable | undefined {
  if (fn.type === "FunctionDeclaration" && fn.id)
    return script.scopeManager.getDeclaredVariables(fn).find((item) => item.name === fn.id.name);
  if (parent?.type === "VariableDeclarator" && FUNCTION_TYPES.has(fn.type))
    return constBinding(script, parent);
  return undefined;
}

/** A named function handed out as a handler or returned from a composable runs when called. */
function isHandlerUse(script: IndexedScript, use: AnyNode, used: AnyNode): boolean {
  if (use?.type === "ReturnStatement" || use?.type === "ExportSpecifier") return true;
  if (use?.type !== "Property" || use.value !== used) return false;
  const [owner] = valueParent(script, script.parent(use));
  return owner?.type === "ReturnStatement";
}
