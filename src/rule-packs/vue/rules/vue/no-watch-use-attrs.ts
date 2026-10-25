import type { RuleContext } from "../../../../core/index.js";
import { scriptMayName } from "../../../../core/internal/script-scope.js";
import { AnyNode, createRule, namePattern, report } from "./shared.js";
import {
  constBinding,
  indexedScript,
  propertyName,
  unwrapTs,
  valueParent,
  vueApiCall,
  type IndexedScript,
} from "./vue-api.js";

const RULE_ID = "vue/attrs/no-watch-use-attrs";
const USE_ATTRS = new Set(["useAttrs"]);
const WATCH = new Set(["watch"]);

type DeadSource = "object" | "array" | "getter";

export const noWatchUseAttrs = createRule({
  meta: {
    id: RULE_ID,
    title: "Do not watch the useAttrs() object",
    category: "attrs",
    severity: "error",
    fixable: "suggestion",
    docsUrl:
      "https://vuejs.org/guide/components/attrs.html#accessing-fallthrough-attributes-in-javascript",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    if (!scriptMayName(ctx, namePattern(["useAttrs"]))) return;
    let sources: Map<number, DeadSource> | undefined;
    return {
      CallExpression(node: AnyNode) {
        sources ??= deadAttrsSources(ctx);
        if (!sources.size) return;
        const first = node.arguments?.[0];
        const candidates =
          unwrapTs(first)?.type === "ArrayExpression" ? unwrapTs(first).elements : [first];
        for (const candidate of candidates) {
          const kind = candidate ? sources.get(candidate.start) : undefined;
          if (!kind) continue;
          const [why, fix] = MESSAGES[kind];
          report(ctx, candidate, RULE_ID, "error", "attrs", why, fix);
        }
      },
    };
  },
});

const PROP_FIX =
  "Declare the attribute as a prop and watch(() => props.name, ...). If it must stay a fallthrough attribute, watch a getter that reads it, watch(() => attrs.name, ...), or read attrs in onUpdated().";

const MESSAGES: Record<DeadSource, [string, string]> = {
  object: [
    'The useAttrs() object is not a ref or reactive object, so watch() rejects it as an invalid source ("Invalid watch source" in development) and the callback never runs when fallthrough attributes change.',
    PROP_FIX,
  ],
  array: [
    "watch() reads each array source as a ref, reactive object, or getter. The useAttrs() object is none of these, so that entry is always undefined and attribute changes never reach the callback.",
    PROP_FIX,
  ],
  getter: [
    "The getter returns the same useAttrs() object every time without reading an attribute, so the watcher has nothing to compare and the callback never runs when fallthrough attributes change.",
    PROP_FIX,
  ],
};

function deadAttrsSources(ctx: RuleContext): Map<number, DeadSource> {
  const result = new Map<number, DeadSource>();
  const script = indexedScript(ctx);
  if (!script) return result;
  try {
    const watchOf = (node: AnyNode): AnyNode => {
      const [call, child] = valueParent(script, node);
      return call?.type === "CallExpression" &&
        call.arguments[0] === child &&
        vueApiCall(script, call.callee, WATCH)
        ? call
        : undefined;
    };
    const visitSource = (node: AnyNode) => {
      const [parent, child] = valueParent(script, node);
      if (watchOf(node)) {
        result.set(child.range[0], "object");
        return;
      }
      if (parent?.type === "ArrayExpression") {
        const call = watchOf(parent);
        if (call && !watchesDeep(call)) result.set(child.range[0], "array");
        return;
      }
      if (
        parent?.type === "ArrowFunctionExpression" &&
        parent.body === child &&
        parent.params.length === 0
      ) {
        const call = watchOf(parent);
        if (call && !watchesDeep(call)) result.set(parent.range[0], "getter");
      }
    };
    for (const call of script.nodes("CallExpression")) {
      if (vueApiCall(script, call.callee, USE_ATTRS) !== "useAttrs") continue;
      const [parent] = valueParent(script, call);
      if (parent?.type === "VariableDeclarator" && unwrapTs(parent.init) === call) {
        for (const reference of attrsReferences(script, parent)) visitSource(reference);
      } else {
        visitSource(call);
      }
    }
  } catch {
    return new Map();
  }
  return result;
}

function attrsReferences(script: IndexedScript, declarator: AnyNode): AnyNode[] {
  const variable = constBinding(script, declarator);
  if (!variable) return [];
  return variable.references
    .filter((reference) => reference.isRead())
    .map((reference) => reference.identifier);
}

/** Deep watchers traverse their source, which reads every attribute and so tracks them. */
function watchesDeep(call: AnyNode): boolean {
  const options = unwrapTs(call.arguments[2]);
  if (!options) return false;
  if (options.type !== "ObjectExpression") return true;
  return options.properties.some(
    (property: AnyNode) => property.type !== "Property" || propertyName(property.key) === "deep",
  );
}
