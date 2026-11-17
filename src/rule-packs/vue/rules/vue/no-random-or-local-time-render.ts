import { AnyNode, createRule, report } from "./shared.js";
import { vueSsrEvidence } from "./ssr-evidence.js";
import { createSsrValueTracer, unwrap, type SsrValue } from "./ssr-values.js";

const RULE_ID = "vue/ssr/no-random-or-local-time-render";
const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/**
 * Render output that depends on the process that renders it: randomness, the current time, or the
 * default locale and time zone. In an SFC every script value is checked; in a `.ts` or `.tsx`
 * file only values inside render functions, `h()` arguments, and JSX.
 */
export const noRandomOrLocalTimeRender = createRule({
  meta: {
    id: RULE_ID,
    title: "Avoid random, current-time, or locale-dependent SSR render values",
    category: "ssr",
    severity: "warn",
    confidence: "heuristic-medium",
    fixable: "suggestion",
    docsUrl: "https://vuejs.org/guide/scaling-up/ssr.html#hydration-mismatch",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    if (ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
    if (/\.client\.[cm]?[jt]sx?$|\.client\.vue$/.test(ctx.file.relativePath)) return;
    if (!ctx.file.isVueSfc && !/\.[cm]?[jt]sx?$/.test(ctx.file.relativePath)) return;
    if (!vueSsrEvidence(ctx)) return;
    const tracer = createSsrValueTracer(ctx, "render");
    const visit = (node: AnyNode) => {
      const rendered = isRenderContext(node);
      if (!ctx.file.isVueSfc && !rendered) return;
      const label = tracer.direct(node);
      // Helpers count where their result reaches the template: render code, or SFC setup state.
      const value: SsrValue | undefined = label
        ? { label, node, via: [] }
        : node.type === "CallExpression" && (rendered || isSfcSetupValue(node))
          ? tracer.call(node)[0]
          : undefined;
      if (!value) return;
      if (ctx.helpers.isTypeOnlyContext(node)) return;
      if (ctx.helpers.isClientOnlyExecutionContext(node, ctx.file.text)) return;
      const read = value.via.length
        ? `${value.via.join(" → ")} reads ${value.label}`
        : `${value.label} runs`;
      report(
        ctx,
        node,
        RULE_ID,
        "warn",
        "ssr",
        `${read} during render. The server and the browser produce different output, from a different clock, random number, locale or time zone, so the first client render does not match the server HTML and Vue logs a hydration mismatch.`,
        "Render a value the server and client agree on, such as an ISO or UTC date with an explicit locale and timeZone, and switch to the local or relative value in onMounted(). Use useId() for ids, or isolate the node with data-allow-mismatch.",
      );
    };
    return { CallExpression: visit, NewExpression: visit };
  },
});

/** A value `<script setup>` computes at its top level or in a computed() getter. */
function isSfcSetupValue(node: AnyNode): boolean {
  const fn = enclosingFunction(node);
  if (!fn) return true;
  const call = fn.__doctorParent;
  return (
    call?.type === "CallExpression" &&
    call.arguments?.[0] === fn &&
    unwrap(call.callee)?.name === "computed" &&
    !enclosingFunction(call)
  );
}

/** Whether `node` is evaluated while a render function builds vnodes. */
function isRenderContext(node: AnyNode): boolean {
  let child = node;
  for (let parent = node.__doctorParent; parent; child = parent, parent = parent.__doctorParent) {
    if (parent.type === "JSXElement" || parent.type === "JSXFragment") return true;
    if (parent.type === "CallExpression" && parent.callee !== child && isH(parent)) return true;
    if (FUNCTION_TYPES.has(parent.type) && isRenderFunction(parent)) return true;
  }
  return false;
}

function isH(call: AnyNode): boolean {
  const callee = unwrap(call.callee);
  return callee?.type === "Identifier" && (callee.name === "h" || callee.name === "createVNode");
}

/** A `render` option, or the function a component's `setup` returns. */
function isRenderFunction(fn: AnyNode): boolean {
  const parent = fn.__doctorParent;
  if (
    parent?.type === "Property" &&
    parent.value === fn &&
    (parent.key?.name ?? parent.key?.value) === "render"
  )
    return true;
  const returned =
    parent?.type === "ReturnStatement"
      ? enclosingFunction(parent)
      : FUNCTION_TYPES.has(parent?.type) && parent.body === fn
        ? parent
        : undefined;
  return Boolean(returned && isSetupFunction(returned));
}

function enclosingFunction(node: AnyNode): AnyNode {
  let current = node.__doctorParent;
  while (current && !FUNCTION_TYPES.has(current.type)) current = current.__doctorParent;
  return current;
}

function isSetupFunction(fn: AnyNode): boolean {
  const property = fn.__doctorParent;
  if (property?.type === "Property" && property.value === fn)
    return (property.key?.name ?? property.key?.value) === "setup";
  // defineComponent((props) => () => h(...))
  const call = property;
  return (
    call?.type === "CallExpression" &&
    call.arguments?.[0] === fn &&
    unwrap(call.callee)?.name === "defineComponent"
  );
}
