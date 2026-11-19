import type { RuleContext, TemplateExpressionNode } from "../../../../core/index.js";
import {
  templateDirectiveBindings,
  templateExpressionReferences,
  TemplateNodeType,
  walkTemplate,
} from "../../../../core/rule-authoring.js";
import { AnyNode, createRule, report } from "./shared.js";
import { indexedScript, valueParent, vueApiCall } from "./vue-api.js";
import { vueSsrEvidence } from "./ssr-evidence.js";
import { createSsrValueTracer, unwrap, type SsrValue } from "./ssr-values.js";

const RULE_ID = "vue/ssr/no-setup-state-from-browser-read";
const STATE_APIS = new Set(["ref", "shallowRef", "reactive", "shallowReactive", "computed"]);
const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/**
 * Reactive state whose initial value comes from a browser read during setup. The server renders
 * the fallback and the first client render the browser value, so hydration mismatches. A
 * `typeof window` or `import.meta.client` guard does not help: it is what makes the two differ.
 */
export const noSetupStateFromBrowserRead = createRule({
  meta: {
    id: RULE_ID,
    title: "Do not initialize SSR-rendered state from a browser read in setup",
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
    const evidence = vueSsrEvidence(ctx);
    if (!evidence) return;
    const script = indexedScript(ctx);
    if (!script) return;
    const tracer = createSsrValueTracer(ctx, "browser");
    let templateReads: Set<string> | undefined;
    return {
      CallExpression(node: AnyNode) {
        const indexed = script.nodeAt("CallExpression", node.start);
        const api = indexed && vueApiCall(script, indexed.callee, STATE_APIS);
        if (!api) return;
        if (ctx.helpers.isClientOnlyExecutionContext(node, ctx.file.text)) return;
        if (!isSetupScope(ctx, node)) return;
        const initial = unwrap(node.arguments?.[0]);
        if (!initial) return;
        const getter = api === "computed" && FUNCTION_TYPES.has(initial.type);
        if (api === "computed" && !getter) return;
        if (getter) {
          const [parent] = valueParent(script, indexed);
          if (parent?.type === "ExpressionStatement") return;
          if (parent?.type === "VariableDeclarator") {
            const variable = script.scopeManager
              .getDeclaredVariables(parent)
              .find((item) => item.identifiers.includes(parent.id));
            const readInScript = variable?.references.some(
              (ref) =>
                ref.isRead() &&
                !ctx.helpers.isClientOnlyExecutionContext(
                  originalNode(node, ref.identifier.range[0]),
                  ctx.file.text,
                ),
            );
            if (!readInScript) {
              templateReads ??= renderTemplateReads(ctx);
              if (!isInScriptSetup(ctx, node) || !templateReads.has(parent.id?.name)) return;
            }
          }
        }
        // An unguarded read throws during the server render instead of rendering differently.
        const value = (getter ? tracer.returned(initial) : tracer.expression(initial)).find(
          (item) => item.guarded,
        );
        if (!value) return;
        report(
          ctx,
          node,
          RULE_ID,
          "warn",
          "ssr",
          `${describe(value)} while setup creates this ${api}() state. The server cannot read it, so it renders the fallback while the first client render uses the browser value, and Vue logs a hydration mismatch. Doctor treats this code as server-rendered because ${evidence}.`,
          "Initialize the state to a value the server can compute too, such as the prop default, and apply the browser value in onMounted(). In a Nuxt app, keep state the server must render in useState() or useCookie(), or render the subtree in <ClientOnly>.",
        );
      },
    };
  },
});

function renderTemplateReads(ctx: RuleContext): Set<string> {
  const reads = new Set<string>();
  const root = ctx.file.templateAst;
  if (!root) return reads;
  const empty = new Set<string>();
  const scopes = new WeakMap<
    object,
    { outer: Set<string>; loop: Set<string>; body: Set<string> }
  >();
  function collect(expression: TemplateExpressionNode | undefined, locals: Set<string>) {
    const ast = expression && ctx.helpers.parseTemplateExpression(expression);
    if (!ast) return;
    for (const { id, mode } of templateExpressionReferences(ast)) {
      if (mode !== "w" && !locals.has(id.name)) reads.add(id.name);
    }
  }
  walkTemplate(root, (node, parent) => {
    const scope = parent && scopes.get(parent);
    const inherited = scope?.body ?? empty;
    if (node.type === TemplateNodeType.ELEMENT) {
      let loop = inherited;
      let slotBindings: string[] = [];
      for (const prop of node.props) {
        if (prop.type !== TemplateNodeType.DIRECTIVE) continue;
        if (prop.name === "for") loop = new Set([...loop, ...templateDirectiveBindings(prop)]);
        if (prop.name === "slot") slotBindings = templateDirectiveBindings(prop);
      }
      const body = slotBindings.length ? new Set([...loop, ...slotBindings]) : loop;
      scopes.set(node, { outer: inherited, loop, body });
    }
    if (node.type === TemplateNodeType.INTERPOLATION) collect(node.content, inherited);
    if (node.type !== TemplateNodeType.DIRECTIVE) return;
    const outer = scope?.outer ?? empty;
    const loop = scope?.loop ?? empty;
    if (node.arg && !node.arg.isStatic) collect(node.arg, loop);
    if (node.name === "for") collect(node.forParseResult?.source, outer);
    else if (node.name === "if" || node.name === "else-if") collect(node.exp, outer);
    else if (node.name !== "on" && node.name !== "slot") collect(node.exp, loop);
  });
  return reads;
}

function describe(value: SsrValue): string {
  return value.via.length
    ? `${value.via.join(" → ")} reads ${value.label}`
    : `${value.label} is read`;
}

/**
 * Whether a call runs once per component instance while it sets up: in `<script setup>`, in the
 * `setup` of component options, or in a composable that setup calls.
 */
function isSetupScope(ctx: { file: { isVueSfc: boolean; sfc?: any } }, node: AnyNode): boolean {
  let fn = node.__doctorParent;
  while (fn && !FUNCTION_TYPES.has(fn.type) && fn.type !== "Program") fn = fn.__doctorParent;
  if (!fn) return false;
  if (fn.type === "Program") return isInScriptSetup(ctx, node);
  if (isComposable(fn)) return true;
  return isSetupOption(fn);
}

function isInScriptSetup(ctx: { file: { isVueSfc: boolean; sfc?: any } }, node: AnyNode): boolean {
  const block = ctx.file.sfc?.descriptor?.scriptSetup;
  if (!ctx.file.isVueSfc || !block) return false;
  return node.start >= block.loc.start.offset && node.end <= block.loc.end.offset;
}

function isComposable(fn: AnyNode): boolean {
  const parent = fn.__doctorParent;
  const name =
    fn.id?.name ??
    (parent?.type === "VariableDeclarator" && parent.init === fn ? parent.id?.name : undefined);
  return typeof name === "string" && /^use[A-Z0-9]/.test(name);
}

function isSetupOption(fn: AnyNode): boolean {
  const property = fn.__doctorParent;
  if (property?.type !== "Property" || property.value !== fn) return false;
  if ((property.key?.name ?? property.key?.value) !== "setup") return false;
  const options = property.__doctorParent;
  if (options?.type !== "ObjectExpression") return false;
  const owner = options.__doctorParent;
  if (owner?.type === "ExportDefaultDeclaration") return true;
  const callee = owner?.type === "CallExpression" ? unwrap(owner.callee) : undefined;
  return callee?.type === "Identifier" && /^define(Component|NuxtComponent)$/.test(callee.name);
}

function originalNode(node: AnyNode, start: number): AnyNode {
  let root = node;
  while (root.__doctorParent) root = root.__doctorParent;
  function visit(current: AnyNode): AnyNode {
    if (!current || typeof current !== "object") return undefined;
    if (current.type === "Identifier" && current.start === start) return current;
    for (const [key, value] of Object.entries(current)) {
      if (key === "__doctorParent" || key === "parent") continue;
      for (const child of Array.isArray(value) ? value : [value]) {
        const found = visit(child);
        if (found) return found;
      }
    }
  }
  return visit(root);
}
