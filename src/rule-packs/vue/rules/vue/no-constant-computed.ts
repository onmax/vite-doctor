import type { RuleContext } from "../../../../core/index.js";
import { scriptMayName } from "../../../../core/internal/script-scope.js";
import { AnyNode, createRule, namePattern, report } from "./shared.js";
import { indexedScript, unwrapTs, vueApiCall } from "./vue-api.js";

const RULE_ID = "vue/reactivity/no-constant-computed";
const COMPUTED = new Set(["computed"]);
const FUNCTION_TYPES = new Set(["ArrowFunctionExpression", "FunctionExpression"]);

/** `computed(() => "Events")` never recomputes: it is a constant with extra steps. */
export const noConstantComputed = createRule({
  meta: {
    id: RULE_ID,
    title: "Review computed() getters with no reactive dependencies",
    category: "reactivity",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://vuejs.org/guide/essentials/computed.html",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    if (!scriptMayName(ctx, namePattern([...COMPUTED]))) return;
    let constants: Map<number, string> | undefined;
    return {
      CallExpression(node: AnyNode) {
        const value = (constants ??= constantComputeds(ctx)).get(node.range?.[0] ?? node.start);
        if (value === undefined) return;
        report(
          ctx,
          node,
          RULE_ID,
          "warn",
          "reactivity",
          `This computed() always returns ${value}. It reads no reactive source, so it never recomputes.`,
          "Keep computed() when consumers require a readonly ComputedRef or .value access. Use a plain const only when no ref contract is required.",
        );
      },
    };
  },
});

function constantComputeds(ctx: RuleContext): Map<number, string> {
  const result = new Map<number, string>();
  const script = indexedScript(ctx);
  if (!script) return result;
  for (const call of script.nodes("CallExpression")) {
    if (!vueApiCall(script, call.callee, COMPUTED)) continue;
    const getter = unwrapTs(call.arguments[0]);
    if (
      !FUNCTION_TYPES.has(getter?.type) ||
      getter.params.length ||
      getter.generator ||
      getter.async
    )
      continue;
    const value = returned(getter);
    if (value && isConstant(value))
      result.set(call.range[0], ctx.file.text.slice(value.range[0], value.range[1]));
  }
  return result;
}

/** The one expression a getter returns: an arrow's body, or a body with a single return. */
function returned(getter: AnyNode): AnyNode {
  if (getter.body?.type !== "BlockStatement") return unwrapTs(getter.body);
  const [only, ...rest] = getter.body.body;
  return !rest.length && only?.type === "ReturnStatement" ? unwrapTs(only.argument) : undefined;
}

function isConstant(node: AnyNode): boolean {
  if (node.type === "Literal") return true;
  if (node.type === "TemplateLiteral") return node.expressions.length === 0;
  if (node.type === "UnaryExpression")
    return node.operator === "-" && node.argument?.type === "Literal";
  return false;
}
