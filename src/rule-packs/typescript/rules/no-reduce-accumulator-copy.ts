import { createRule } from "../../../core/index.js";
import { parentOf, isTypeScriptSource, report, type AnyNode } from "./shared.js";
import { arrayMethod, createLocalEvidence, expression } from "./local-evidence.js";

const ruleId = "typescript/performance/no-reduce-accumulator-copy";

export const noReduceAccumulatorCopy = createRule({
  meta: {
    id: "typescript/performance/no-reduce-accumulator-copy",
    title: "Avoid copying growing reducer accumulators",
    description: "Detect repeated accumulator copies in inline reduce and reduceRight callbacks.",
    why: "Copying accumulated state on every iteration can cause quadratic work as the accumulator grows. This rule covers Object.assign, Array.from, and array copy methods with local array evidence. It does not prove receiver types or accumulator growth; bounded copies may be intentional. Spreads and named callbacks are outside its scope.",
    recommendedReplacement:
      "Use a fresh, locally owned accumulator and update it in place after reviewing ownership. Do not mutate shared initial state.",
    examples: [
      {
        title: "Avoid copying growing reducer accumulators",
        language: "ts",
        invalid: "items.reduce((acc, item) => acc.concat([item]), [])",
        valid: "items.reduce((acc, item) => { acc.push(item); return acc }, [])",
      },
    ],
    category: "performance",
    severity: "warn",
    fixable: "structural-review",
    docsUrl:
      "https://github.com/dmmulroy/anti-slop/tree/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b#rules",
    requires: { script: true },
    aiGeneratedCodeRisk: "high",
  },
  create(ctx) {
    if (!isTypeScriptSource(ctx)) return;
    let evidence: ReturnType<typeof createLocalEvidence>;
    function references(
      node: AnyNode,
      accumulator: unknown,
      owner: AnyNode,
      seen = new Set<unknown>(),
    ): boolean {
      const target = evidence.binding(expression(node));
      if (!target || target.written || seen.has(target)) return false;
      if (target === accumulator) return true;
      if (target.kind !== "const" || target.owner !== owner || target.node.start >= node.start)
        return false;
      seen.add(target);
      return references(target.init, accumulator, owner, seen);
    }
    return {
      ScriptNode(node: AnyNode) {
        if (node.type === "Program") {
          evidence = createLocalEvidence(node);
          return;
        }
        if (node.type !== "CallExpression" || node.optional) return;
        const method = arrayMethod(node.callee);
        if (!method) return;
        const callback = evidence.owner(node);
        if (!["ArrowFunctionExpression", "FunctionExpression"].includes(callback?.type)) return;
        const reducer = parentOf(callback);
        if (
          reducer?.type !== "CallExpression" ||
          reducer.optional ||
          reducer.arguments.length !== 2 ||
          reducer.arguments[0] !== callback
        )
          return;
        const reducerMethod = arrayMethod(reducer.callee);
        if (!reducerMethod || !["reduce", "reduceRight"].includes(reducerMethod.name)) return;
        const parameter = callback.params[0];
        if (parameter?.type !== "Identifier") return;
        const accumulator = evidence.binding(parameter);
        const isAccumulator = (value: AnyNode) => references(value, accumulator, callback);
        const globalOwner = (name: string) =>
          method.object?.type === "Identifier" &&
          method.object.name === name &&
          !evidence.binding(method.object);
        let copies = false;
        if (method.name === "assign" && globalOwner("Object"))
          copies =
            expression(node.arguments[0])?.type === "ObjectExpression" &&
            node.arguments.slice(1).some(isAccumulator);
        else if (method.name === "from" && globalOwner("Array"))
          copies = isAccumulator(node.arguments[0]);
        else if (
          ["concat", "slice", "toSpliced", "toSorted", "toReversed", "with"].includes(method.name)
        )
          copies = evidence.isArray(reducer.arguments[1]) && isAccumulator(method.object);
        if (copies)
          report(
            ctx,
            node,
            ruleId,
            "This reducer copies accumulated state on every iteration; growing copies can cause quadratic work.",
            "Update a fresh, locally owned accumulator in place after reviewing ownership. Preserve shared or externally owned initial state.",
          );
      },
    };
  },
});
