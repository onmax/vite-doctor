import type { RuleContext } from "../../../../core/index.js";
import { scriptMayName } from "./script-scope.js";
import { AnyNode, createRule, namePattern, report } from "./shared.js";
import {
  constBinding,
  indexedScript,
  propertyName,
  unwrapTs,
  valueParent,
  vueApiCall,
} from "./vue-api.js";

const RULE_ID = "vue/reactivity/no-reactive-destructure";
const REACTIVE = new Set(["reactive", "shallowReactive"]);

interface Snapshot {
  /** The reactive binding destructured, or none when the reactive() call itself is. */
  source?: string;
  keys: string[];
}

export const noReactiveDestructure = createRule({
  meta: {
    id: RULE_ID,
    title: "Do not destructure primitives from reactive()",
    category: "reactivity",
    severity: "error",
    fixable: "suggestion",
    docsUrl:
      "https://vuejs.org/guide/essentials/reactivity-fundamentals.html#limitations-of-reactive",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    if (!scriptMayName(ctx, namePattern([...REACTIVE]))) return;
    let snapshots: Map<number, Snapshot> | undefined;
    return {
      VariableDeclarator(node: AnyNode) {
        const snapshot = (snapshots ??= reactiveSnapshots(ctx)).get(node.start);
        if (!snapshot) return;
        const keys = snapshot.keys.join(", ");
        const [key] = snapshot.keys;
        const [why, fix] = snapshot.source
          ? [
              `Destructuring ${keys} from the reactive object ${snapshot.source} copies the current primitive values into plain locals. Vue tracks reactive() state through property access on the proxy, so later writes to ${snapshot.source}.${key} never reach these locals, the template, or computed values and watchers that read them.`,
              `Read ${snapshot.source}.${key} where the value is used, or destructure toRefs(${snapshot.source}) and read ${key}.value in script.`,
            ]
          : [
              `Destructuring ${keys} straight out of reactive() copies primitive values into plain locals and discards the proxy, so these values are never reactive: assigning them does not update the template, computed values, or watchers.`,
              `Keep the object (const state = reactive({ ... })) and read state.${key}, or declare each value with ref().`,
            ];
        report(ctx, node.id, RULE_ID, "error", "reactivity", why, fix);
      },
    };
  },
});

function reactiveSnapshots(ctx: RuleContext): Map<number, Snapshot> {
  const result = new Map<number, Snapshot>();
  const script = indexedScript(ctx);
  if (!script) return result;
  try {
    for (const declarator of script.nodes("VariableDeclarator")) {
      const init = unwrapTs(declarator.init);
      if (init?.type !== "CallExpression" || !vueApiCall(script, init.callee, REACTIVE)) continue;
      const primitives = primitiveKeys(init.arguments[0]);
      if (!primitives.size) continue;
      if (declarator.id.type === "ObjectPattern") {
        const keys = destructuredKeys(declarator.id, primitives);
        if (keys.length) result.set(declarator.range[0], { keys });
        continue;
      }
      const variable = constBinding(script, declarator);
      if (!variable) continue;
      const owner = script.owner(declarator);
      for (const reference of variable.references) {
        if (!reference.isRead()) continue;
        const [target, init] = valueParent(script, reference.identifier);
        if (
          target?.type !== "VariableDeclarator" ||
          target.init !== init ||
          target.id.type !== "ObjectPattern" ||
          script.owner(target) !== owner
        )
          continue;
        const keys = destructuredKeys(target.id, primitives);
        if (keys.length) result.set(target.range[0], { source: variable.name, keys });
      }
    }
  } catch {
    return new Map();
  }
  return result;
}

/**
 * Keys the reactive() argument initializes with a primitive literal. Nested objects stay reactive
 * proxies after destructuring and unknown sources may hold refs or objects, so only these are
 * certain to become disconnected snapshots.
 */
function primitiveKeys(argument: AnyNode): Set<string> {
  const keys = new Set<string>();
  const object = unwrapTs(argument);
  if (object?.type !== "ObjectExpression") return keys;
  for (const property of object.properties) {
    if (property.type !== "Property" || property.computed || property.kind !== "init") continue;
    const key = propertyName(property.key);
    if (key && isPrimitive(unwrapTs(property.value))) keys.add(key);
  }
  return keys;
}

function isPrimitive(node: AnyNode): boolean {
  if (node?.type === "Literal") return !("regex" in node && node.regex);
  if (node?.type === "TemplateLiteral") return true;
  if (node?.type === "Identifier") return node.name === "undefined";
  if (node?.type === "UnaryExpression")
    return ["-", "+", "!"].includes(node.operator) && isPrimitive(node.argument);
  return false;
}

function destructuredKeys(pattern: AnyNode, primitives: Set<string>): string[] {
  const keys: string[] = [];
  for (const property of pattern.properties) {
    if (property.type !== "Property" || property.computed) continue;
    const key = propertyName(property.key);
    if (key && primitives.has(key)) keys.push(key);
  }
  return keys;
}
