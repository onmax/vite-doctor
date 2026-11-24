import type { RuleContext } from "../../../../core/index.js";
import { scriptMayName } from "../../../../core/internal/script-scope.js";
import { AnyNode, createRule, namePattern } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";
import {
  constBinding,
  indexedScript,
  memberName,
  unwrapTs,
  vueApiCall,
  type IndexedScript,
} from "./vue-api.js";

const RULE_ID = "vue/watch/no-property-read-source";
const WATCH = new Set(["watch"]);
const REACTIVE = new Set(["reactive"]);

interface PropertySource {
  node: AnyNode;
  text: string;
  receiver: "props" | "reactive";
}

/**
 * `watch(props.user, cb)` hands watch() the property's current value, not a way to read it again.
 * A primitive is an invalid source, and an object is watched as that one object, so replacing the
 * property never runs the callback.
 */
export const noPropertyReadWatchSource = createRule({
  meta: {
    id: RULE_ID,
    title: "Watch a reactive property through a getter",
    category: "watchers",
    severity: "error",
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://vuejs.org/guide/essentials/watchers.html#watch-source-types",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    if (!scriptMayName(ctx, namePattern([...WATCH]))) return;
    return {
      Program() {
        for (const source of propertySources(ctx)) {
          const owner = source.receiver === "props" ? "defineProps() object" : "reactive() object";
          ctx.report(
            diagnostics.VUE0050({
              why: `watch(${source.text}, ...) reads the property once and passes its current value. A primitive is not a valid watch source: Vue warns "Invalid watch source" and the callback never runs. An object is watched as that one object, so assigning a new value to the property of the ${owner} never runs the callback.`,
              fix: `Pass a getter: watch(() => ${source.text}, ...). Add { deep: true } if the callback should also run when something inside the value changes.`,
            }),
            {
              ruleId: RULE_ID,
              severity: "error",
              category: "watchers",
              file: ctx.file.path,
              range: ctx.range(source.node.range[0], source.node.range[1]),
              fix: {
                kind: "suggestion",
                message: "Wrap the source in a getter.",
                edits: [
                  {
                    range: { start: source.node.range[0], end: source.node.range[1] },
                    text: `() => ${source.text}`,
                  },
                ],
              },
            },
          );
        }
      },
    };
  },
});

function propertySources(ctx: RuleContext): PropertySource[] {
  const script = indexedScript(ctx);
  if (!script) return [];
  const result: PropertySource[] = [];
  try {
    for (const call of script.nodes("CallExpression")) {
      if (!vueApiCall(script, call.callee, WATCH)) continue;
      const source = unwrapTs(call.arguments[0]);
      const candidates = source?.type === "ArrayExpression" ? source.elements : [source];
      for (const candidate of candidates) {
        const node = unwrapTs(candidate);
        const receiver = propertyReceiver(script, node);
        if (!receiver) continue;
        result.push({
          node: candidate,
          text: ctx.file.text.slice(candidate.range[0], candidate.range[1]),
          receiver,
        });
      }
    }
  } catch {
    return [];
  }
  return result;
}

/**
 * The kind of object a `receiver.key` chain starts at. Every step must be a named property read:
 * reactive() unwraps refs stored under named keys, so the chain always yields a plain value.
 */
function propertyReceiver(
  script: IndexedScript,
  node: AnyNode,
): PropertySource["receiver"] | undefined {
  if (node?.type === "ChainExpression") node = node.expression;
  if (node?.type !== "MemberExpression") return undefined;
  while (node.type === "MemberExpression") {
    const name = memberName(node);
    if (name === undefined || /^\d+$/.test(name)) return undefined;
    node = unwrapTs(node.object);
  }
  if (node.type !== "Identifier") return undefined;
  const variable = script.references.get(node)?.resolved;
  const definition = variable?.defs[0];
  if (variable?.defs.length !== 1 || definition?.type !== "Variable") return undefined;
  const declarator = definition.node as AnyNode;
  if (constBinding(script, declarator) !== variable) return undefined;
  const init = unwrapTs(declarator.init);
  if (isDefineProps(script, init)) return "props";
  if (
    init?.type === "CallExpression" &&
    vueApiCall(script, init.callee, REACTIVE) &&
    unwrapTs(init.arguments[0])?.type === "ObjectExpression"
  )
    return "reactive";
  return undefined;
}

/** `defineProps()` or `withDefaults(defineProps(), ...)`, the compiler macros. */
function isDefineProps(script: IndexedScript, node: AnyNode): boolean {
  if (node?.type !== "CallExpression") return false;
  const callee = unwrapTs(node.callee);
  if (callee?.type !== "Identifier" || script.references.get(callee)?.resolved) return false;
  if (callee.name === "withDefaults") return isDefineProps(script, unwrapTs(node.arguments[0]));
  return callee.name === "defineProps";
}
