import type { SFCDescriptor } from "@vue/compiler-sfc";
import type { RuleContext } from "../../../../core/index.js";
import { scriptMayName, type ScopeVariable } from "../../../../core/internal/script-scope.js";
import { AnyNode, bindingNames, createRule, namePattern, report } from "./shared.js";
import {
  constBinding,
  indexedScript,
  memberName,
  propertyName,
  unwrapTs,
  valueParent,
  vueApiCall,
  type IndexedScript,
} from "./vue-api.js";

const RULE_ID = "vue/reactivity/prefer-computed-over-watch-assign";
const WATCHERS = new Set(["watch", "watchEffect"]);
const REFS = new Set(["ref", "shallowRef"]);
const FUNCTION_TYPES = new Set(["ArrowFunctionExpression", "FunctionExpression"]);
const SIDE_EFFECT_TYPES = new Set([
  "AssignmentExpression",
  "UpdateExpression",
  "AwaitExpression",
  "YieldExpression",
]);

interface DerivedWatch {
  target: string;
  expression: string;
  /** A watch() without `immediate`, which Vue never runs before a source changes or during SSR. */
  lazy: boolean;
  fromCallbackValue: boolean;
}

export const preferComputedOverWatchAssign = createRule({
  meta: {
    id: RULE_ID,
    title: "Derive state with computed() instead of a watcher",
    category: "reactivity",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://vuejs.org/guide/essentials/computed.html",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    if (!scriptMayName(ctx, namePattern([...WATCHERS]))) return;
    let watches: Map<number, DerivedWatch> | undefined;
    return {
      CallExpression(node: AnyNode) {
        const watch = (watches ??= derivedWatches(ctx)).get(node.start);
        if (!watch) return;
        const { target, expression } = watch;
        const timing = watch.lazy
          ? `Without immediate, Vue does not run the callback until a source changes, and never during SSR, so ${target} keeps its initial value until then.`
          : `The watcher writes ${target} in a later flush, so code that reads ${target}.value right after changing a source still sees the old value.`;
        report(
          ctx,
          node,
          RULE_ID,
          "warn",
          "reactivity",
          `This watcher only assigns ${target}.value = ${expression}, a value derived from reactive sources. ${timing} computed() derives the value on read and is never out of date.`,
          watch.fromCallbackValue
            ? `Replace the ref and the watcher with const ${target} = computed(() => ...), computing ${expression} from the watched source instead of the callback argument.`
            : `Replace the ref and the watcher with const ${target} = computed(() => ${expression}).`,
        );
      },
    };
  },
});

function derivedWatches(ctx: RuleContext): Map<number, DerivedWatch> {
  const result = new Map<number, DerivedWatch>();
  const script = indexedScript(ctx);
  if (!script) return result;
  const template = (ctx.file.sfc?.descriptor as SFCDescriptor | undefined)?.template?.content ?? "";
  try {
    for (const call of script.nodes("CallExpression")) {
      const kind = vueApiCall(script, call.callee, WATCHERS);
      if (!kind) continue;
      const effect = kind !== "watch";
      const callback = unwrapTs(call.arguments[effect ? 0 : 1]);
      if (!FUNCTION_TYPES.has(callback?.type) || callback.async || callback.generator) continue;
      if (!plainOptions(call.arguments[effect ? 1 : 2], effect)) continue;
      const assignment = onlyAssignment(callback);
      if (!assignment) continue;
      const target = derivedRef(script, assignment.left, call);
      if (!target || writtenByTemplate(template, target.name)) continue;
      const read = readVariables(script, assignment.right);
      if (!read || read.has(target)) continue;
      if (effect ? !read.size : !derivesFromSources(script, call, callback, read)) continue;
      const isImmediate = effect ? false : immediate(call.arguments[2]);
      if (isImmediate === undefined) continue;
      result.set(call.range[0], {
        target: target.name,
        expression: ctx.file.text.slice(assignment.right.range[0], assignment.right.range[1]),
        lazy: !effect && !isImmediate,
        fromCallbackValue: !effect && readsParameter(script, callback, read, 0),
      });
    }
  } catch {
    return new Map();
  }
  return result;
}

/**
 * Options a computed() reproduces. `once`, post-flush DOM effects, and sync watchers have timing
 * a computed() does not, so those stay silent.
 */
function plainOptions(options: AnyNode, effect: boolean): boolean {
  options = unwrapTs(options);
  if (!options) return true;
  if (options.type !== "ObjectExpression") return false;
  return options.properties.every((property: AnyNode) => {
    if (property.type !== "Property" || property.computed) return false;
    const key = propertyName(property.key);
    if (key === "flush") return property.value.type === "Literal" && property.value.value === "pre";
    if (key === "onTrack" || key === "onTrigger") return true;
    return !effect && (key === "immediate" || key === "deep");
  });
}

function immediate(options: AnyNode): boolean | undefined {
  options = unwrapTs(options);
  if (!options) return false;
  if (options.type !== "ObjectExpression") return undefined;
  for (const property of options.properties) {
    if (property.type !== "Property" || property.computed) return undefined;
    if (propertyName(property.key) !== "immediate") continue;
    const value = unwrapTs(property.value);
    if (value.type === "Literal") return Boolean(value.value);
    if (value.type === "Identifier" && value.name === "undefined") return false;
    if (value.type === "UnaryExpression" && value.operator === "void") return false;
    return undefined;
  }
  return false;
}

function onlyAssignment(callback: AnyNode): AnyNode {
  let expression = callback.body;
  if (expression.type === "BlockStatement") {
    if (expression.body.length !== 1 || expression.body[0].type !== "ExpressionStatement")
      return undefined;
    expression = expression.body[0].expression;
  }
  return expression.type === "AssignmentExpression" && expression.operator === "="
    ? expression
    : undefined;
}

/**
 * The local ref the watcher assigns, when that assignment is its only writer: other writes,
 * template writes, or handing the ref itself to other code mean it is not purely derived.
 */
function derivedRef(
  script: IndexedScript,
  left: AnyNode,
  call: AnyNode,
): ScopeVariable | undefined {
  if (left.type !== "MemberExpression" || memberName(left) !== "value" || left.computed) return;
  const object = left.object;
  if (object.type !== "Identifier") return;
  const variable = script.references.get(object)?.resolved;
  const definition = variable?.defs[0];
  if (variable?.defs.length !== 1 || definition?.type !== "Variable") return;
  const declarator = definition.node as AnyNode;
  const init = unwrapTs(declarator.init);
  if (
    constBinding(script, declarator) !== variable ||
    init?.type !== "CallExpression" ||
    !vueApiCall(script, init.callee, REFS) ||
    script.owner(declarator) !== script.owner(call)
  )
    return;
  for (const reference of variable.references) {
    if (reference.init) continue;
    const identifier = reference.identifier;
    if (identifier === object) continue;
    const [member, child] = valueParent(script, identifier);
    if (
      member?.type !== "MemberExpression" ||
      member.object !== child ||
      memberName(member) !== "value"
    )
      return;
    const [parent] = valueParent(script, member);
    if (
      (parent?.type === "AssignmentExpression" && parent.left === member) ||
      parent?.type === "UpdateExpression" ||
      (parent?.type === "UnaryExpression" && parent.operator === "delete")
    )
      return;
  }
  return variable;
}

/** Template writes: v-model, a template ref, or an assignment inside an attribute value. */
function writtenByTemplate(template: string, name: string): boolean {
  if (!template.includes(name)) return false;
  const id = name.replace(/\$/g, "\\$");
  const binding = new RegExp(`(?:v-model(?:[:.][\\w.:-]*)?|\\bref)\\s*=\\s*(["'])\\s*${id}\\s*\\1`);
  if (binding.test(template)) return true;
  const write = new RegExp(
    `(?<![\\w$.])${id}\\s*(?:[-+*/%&|^]|\\*\\*|<<|>>>?|&&|\\|\\||\\?\\?)?=(?![=>])|(?<![\\w$.])${id}\\s*(?:\\+\\+|--)|(?:\\+\\+|--)\\s*${id}(?![\\w$])`,
  );
  for (const [, , value] of template.matchAll(/=\s*(["'])([\s\S]*?)\1/g))
    if (value?.includes(name) && write.test(value)) return true;
  return false;
}

/** Variables the expression reads, or `undefined` when evaluating it has side effects. */
function readVariables(script: IndexedScript, expression: AnyNode): Set<ScopeVariable> | undefined {
  const read = new Set<ScopeVariable>();
  let pure = true;
  const visit = (node: AnyNode) => {
    if (!pure || !node?.type) return;
    if (SIDE_EFFECT_TYPES.has(node.type)) {
      pure = false;
      return;
    }
    if (node.type === "Identifier") {
      const variable = script.references.get(node)?.resolved;
      if (variable) read.add(variable);
    }
    for (const key of script.visitorKeys[node.type] ?? []) {
      const value = node[key];
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  };
  visit(expression);
  return pure ? read : undefined;
}

/**
 * Whether the assigned value comes from the watched value: the callback's first parameter or a
 * variable the source reads. Old values and onCleanup have no computed() equivalent.
 */
function derivesFromSources(
  script: IndexedScript,
  call: AnyNode,
  callback: AnyNode,
  read: Set<ScopeVariable>,
): boolean {
  if (readsParameter(script, callback, read, 1) || readsParameter(script, callback, read, 2))
    return false;
  if (readsParameter(script, callback, read, 0)) return true;
  const sources = readVariables(script, call.arguments[0]);
  return [...(sources ?? [])].some((variable) => read.has(variable));
}

function readsParameter(
  script: IndexedScript,
  callback: AnyNode,
  read: Set<ScopeVariable>,
  index: number,
): boolean {
  const names = new Set(bindingNames(callback.params[index]));
  if (!names.size) return false;
  return (script.scopeManager.acquire(callback)?.variables ?? []).some(
    (variable) => names.has(variable.name) && read.has(variable),
  );
}
