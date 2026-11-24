import type { SFCDescriptor } from "@vue/compiler-sfc";
import type { RuleContext } from "../../../../core/index.js";
import { scriptMayName, type ScopeVariable } from "../../../../core/internal/script-scope.js";
import { AnyNode, createRule, namePattern, report } from "./shared.js";
import {
  matchesPrefix,
  renderTemplateReads,
  templateWrites,
  type PropertyPath,
} from "./template-reads.js";
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
const POST_RENDER_HOOKS = new Set(["onMounted", "onUpdated", "onActivated", "onDeactivated"]);
const SCHEDULED_VUE_CALLBACKS = new Set(["watch", "watchEffect", "watchPostEffect", "nextTick"]);
const LATER_GLOBALS = new Set([
  "setTimeout",
  "setInterval",
  "requestAnimationFrame",
  "requestIdleCallback",
  "queueMicrotask",
]);
const PROMISE_METHODS = new Set(["then", "catch", "finally"]);
const PROMISE_FACTORIES = new Set(["resolve", "reject", "all", "allSettled", "any", "race"]);
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
  const descriptor = ctx.file.sfc?.descriptor as SFCDescriptor | undefined;
  const setup = descriptor?.scriptSetup;
  const setupMaySuspend =
    !!setup &&
    script
      .nodes("AwaitExpression")
      .some(
        (node) =>
          !script.owner(node) &&
          node.range[0] >= setup.loc.start.offset &&
          node.range[1] <= setup.loc.end.offset,
      );
  const result: DeepMutation[] = [];
  try {
    for (const call of script.nodes("CallExpression")) {
      if (!vueApiCall(script, call.callee, SHALLOW_REF)) continue;
      const [declarator, child] = valueParent(script, call);
      if (declarator?.type !== "VariableDeclarator" || declarator.init !== child) continue;
      const variable = constBinding(script, declarator);
      if (!variable) continue;
      const values = [call.arguments[0]];
      const mutations: Mutation[] = [];
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
      const templateScope = !declarationOwner && !!setup;
      const timing = { declarationOwner, setupMaySuspend: templateScope && setupMaySuspend };
      const writes = templateScope ? templateWrites(ctx, name) : [];
      if (writes.some((write) => !write.path.length)) continue;
      if (!readReactively && !(templateScope && renderTemplateReads(ctx).has(name))) continue;
      for (const mutation of mutations) {
        if (assignedIn.has(script.owner(mutation.node))) continue;
        if (
          writes.some((write) => changesReceiver(undefined, mutation, write.path, write.operation))
        )
          continue;
        if (
          mutations.some(
            (write) =>
              !write.method &&
              changesReceiver(script, mutation, [...write.path, write.key], write.node),
          )
        )
          continue;
        if (!values.every((value) => mutatesPlainValue(script, value, mutation))) continue;
        if (!laterPath(script, mutation.node, timing, new Set())) continue;
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

interface Mutation {
  kind: "mutation";
  node: AnyNode;
  path: PropertyPath;
  key?: string;
  method?: string;
  target: AnyNode;
}

function changesReceiver(
  script: IndexedScript | undefined,
  mutation: Mutation,
  path: PropertyPath,
  operation: AnyNode,
): boolean {
  const target = mutation.method ? [...mutation.path, mutation.method] : mutation.path;
  if (!matchesPrefix(path, target)) return false;
  if (path.length > mutation.path.length || path.includes(undefined)) return true;
  return (
    operation?.type !== "AssignmentExpression" ||
    operation.operator !== "=" ||
    !mutatesPlainValue(script, operation.right, {
      ...mutation,
      path: mutation.path.slice(path.length),
    })
  );
}

type Use =
  | { kind: "value-assignment"; value: AnyNode }
  | Mutation
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
  const path: (string | undefined)[] = [];
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
      if (written) return { kind: "mutation", node: next, path, key: name, target: parent };
      if (next?.type === "CallExpression" && next.callee === nextChild && name !== undefined)
        return { kind: "mutation", node: next, path, method: name, target: child };
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
  script: IndexedScript | undefined,
  value: AnyNode,
  mutation: Mutation,
): boolean {
  let node = unwrapTs(value);
  for (const key of mutation.path) {
    if (node?.type !== "ObjectExpression" || key === undefined) return false;
    let found: AnyNode;
    for (const property of node.properties) {
      if (property.type !== "Property" || property.kind !== "init") return false;
      const name = property.computed ? undefined : (property.key.name ?? property.key.value);
      if (name === undefined || name === "__proto__") return false;
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

function plainKind(script: IndexedScript | undefined, node: AnyNode): string | undefined {
  if (node?.type === "ObjectExpression") {
    return node.properties.every(
      (property: AnyNode) =>
        property.type === "Property" &&
        property.kind === "init" &&
        !property.computed &&
        (property.key.name ?? property.key.value) !== "__proto__",
    )
      ? "object"
      : undefined;
  }
  if (node?.type === "ArrayExpression") return "array";
  if (node?.type !== "NewExpression" || node.callee?.type !== "Identifier") return undefined;
  if (!script || script.references.get(node.callee)?.resolved) return undefined;
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

interface SetupTiming {
  declarationOwner: AnyNode;
  setupMaySuspend: boolean;
}

/** Whether the mutation runs after setup returned, when something may already have read the ref. */
function laterPath(
  script: IndexedScript,
  node: AnyNode,
  timing: SetupTiming,
  seen: Set<AnyNode>,
): boolean {
  for (let fn = script.owner(node); fn && fn !== timing.declarationOwner; fn = script.owner(fn)) {
    if (runsLater(script, fn, node, timing, seen)) return true;
  }
  return false;
}

function runsLater(
  script: IndexedScript,
  fn: AnyNode,
  at: AnyNode,
  timing: SetupTiming,
  seen: Set<AnyNode>,
): boolean {
  if (!timing.setupMaySuspend && fn.async && awaitsBefore(script, fn, at)) return true;
  const [parent, child] = valueParent(script, fn);
  if (parent?.type === "CallExpression" && parent.arguments.includes(child))
    return callsLater(script, parent, child, timing.setupMaySuspend);
  const binding = functionBinding(script, fn, parent);
  if (!binding || seen.has(fn)) return false;
  seen.add(fn);
  try {
    for (const reference of binding.references) {
      if (reference.init) continue;
      const [use, used] = valueParent(script, reference.identifier);
      if (use?.type === "CallExpression" && use.callee === used) {
        if (!laterPath(script, use, timing, seen)) return false;
      } else if (use?.type === "CallExpression" && use.arguments.includes(used)) {
        if (!callsLater(script, use, used, timing.setupMaySuspend)) return false;
      } else if (!isHandlerUse(script, use, used)) return false;
    }
    return true;
  } finally {
    seen.delete(fn);
  }
}

function awaitsBefore(script: IndexedScript, fn: AnyNode, at: AnyNode): boolean {
  for (
    let child = at, parent = script.parent(child);
    parent && parent !== fn;
    child = parent, parent = script.parent(child)
  ) {
    if (script.owner(child) !== fn) return false;
    if (parent.type !== "BlockStatement" && parent.type !== "Program") continue;
    for (const statement of parent.body) {
      if (statement === child) break;
      if (
        statement.type === "ExpressionStatement" &&
        unwrapTs(statement.expression)?.type === "AwaitExpression"
      )
        return true;
      if (
        statement.type === "VariableDeclaration" &&
        statement.declarations.some(
          (declaration: AnyNode) => unwrapTs(declaration.init)?.type === "AwaitExpression",
        )
      )
        return true;
    }
  }
  return false;
}

/** Whether `call` runs its function argument `argument` later, as a hook or scheduled callback. */
function callsLater(
  script: IndexedScript,
  call: AnyNode,
  argument: AnyNode,
  setupMaySuspend: boolean,
): boolean {
  if (vueApiCall(script, call.callee, POST_RENDER_HOOKS)) return call.arguments[0] === argument;
  if (setupMaySuspend) return false;
  const watcher = vueApiCall(script, call.callee, SCHEDULED_VUE_CALLBACKS);
  if (watcher === "watch") {
    if (call.arguments[1] !== argument) return false;
    if (call.arguments.length < 3) return true;
    const options = watchOptions(call.arguments[2]);
    return (
      !!options &&
      (!options.has("immediate") || options.get("immediate")?.value === false) &&
      (!options.has("flush") || ["pre", "post"].includes(options.get("flush")?.value))
    );
  }
  if (watcher === "watchEffect")
    return (
      call.arguments[0] === argument &&
      watchOptions(call.arguments[1])?.get("flush")?.value === "post"
    );
  if (watcher) return call.arguments[0] === argument;
  const callee = unwrapTs(call.callee);
  if (callee?.type === "Identifier")
    return (
      call.arguments[0] === argument &&
      LATER_GLOBALS.has(callee.name) &&
      !script.references.get(callee)?.resolved
    );
  const method = memberName(callee);
  return (
    !!method &&
    PROMISE_METHODS.has(method) &&
    (call.arguments[0] === argument || (method === "then" && call.arguments[1] === argument)) &&
    isNativePromise(script, callee.object)
  );
}

function watchOptions(node: AnyNode): Map<string, AnyNode> | undefined {
  node = unwrapTs(node);
  if (node?.type !== "ObjectExpression") return undefined;
  const options = new Map<string, AnyNode>();
  for (const property of node.properties) {
    if (property.type !== "Property" || property.computed || property.kind !== "init")
      return undefined;
    const key = property.key.name ?? property.key.value;
    if (typeof key !== "string" || key === "__proto__") return undefined;
    options.set(key, unwrapTs(property.value));
  }
  return options;
}

function isGlobal(script: IndexedScript, node: AnyNode, name: string): boolean {
  node = unwrapTs(node);
  return (
    node?.type === "Identifier" && node.name === name && !script.references.get(node)?.resolved
  );
}

function isNativePromise(script: IndexedScript, node: AnyNode): boolean {
  node = unwrapTs(node);
  if (node?.type === "NewExpression") return isGlobal(script, node.callee, "Promise");
  if (node?.type !== "CallExpression") return false;
  const callee = unwrapTs(node.callee);
  const method = memberName(callee);
  if (!method) return false;
  if (PROMISE_FACTORIES.has(method) && isGlobal(script, callee.object, "Promise")) return true;
  return PROMISE_METHODS.has(method) && isNativePromise(script, callee.object);
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
