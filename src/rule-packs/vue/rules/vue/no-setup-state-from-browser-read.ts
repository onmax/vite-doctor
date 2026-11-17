import { AnyNode, createRule, report } from "./shared.js";
import { vueSsrEvidence } from "./ssr-evidence.js";
import { createSsrValueTracer, unwrap, type SsrValue } from "./ssr-values.js";

const RULE_ID = "vue/ssr/no-setup-state-from-browser-read";
const STATE_APIS = new Set(["ref", "shallowRef", "reactive", "shallowReactive", "computed"]);
const VUE_SOURCES = /^(?:vue|vue-demi|@vue\/(?:runtime-core|runtime-dom|reactivity)|#imports)$/;
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
    prefilter: { names: [...STATE_APIS] },
  },
  create(ctx) {
    if (ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
    if (/\.client\.[cm]?[jt]sx?$|\.client\.vue$/.test(ctx.file.relativePath)) return;
    const evidence = vueSsrEvidence(ctx);
    if (!evidence) return;
    const tracer = createSsrValueTracer(ctx, "browser");
    return {
      CallExpression(node: AnyNode) {
        const api = stateApi(node);
        if (!api || !isSetupScope(ctx, node)) return;
        const initial = unwrap(node.arguments?.[0]);
        if (!initial) return;
        const getter = api === "computed" && FUNCTION_TYPES.has(initial.type);
        if (api === "computed" && !getter) return;
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

function describe(value: SsrValue): string {
  return value.via.length
    ? `${value.via.join(" → ")} reads ${value.label}`
    : `${value.label} is read`;
}

/** The Vue state API a call creates, when it is imported from Vue or auto-imported. */
function stateApi(node: AnyNode): string | undefined {
  const callee = unwrap(node.callee);
  if (callee?.type !== "Identifier" || !STATE_APIS.has(callee.name)) return undefined;
  const source = importSource(callee);
  return source === undefined || VUE_SOURCES.test(source) ? callee.name : undefined;
}

/** The module an identifier is imported from, `undefined` for an unbound name, `""` for locals. */
function importSource(identifier: AnyNode): string | undefined {
  let scope = identifier.__doctorParent;
  while (scope) {
    if (FUNCTION_TYPES.has(scope.type) && declares(scope.params, identifier.name)) return "";
    if (scope.type === "Program" || scope.type === "BlockStatement") {
      for (const statement of scope.body ?? []) {
        if (statement.type === "ImportDeclaration") {
          if (
            (statement.specifiers ?? []).some(
              (specifier: AnyNode) => specifier.local?.name === identifier.name,
            )
          )
            return statement.source.value;
          continue;
        }
        const declaration =
          statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
        if (declaration?.type === "FunctionDeclaration" && declaration.id?.name === identifier.name)
          return "";
        if (
          declaration?.type === "VariableDeclaration" &&
          declares(
            (declaration.declarations ?? []).map((item: AnyNode) => item.id),
            identifier.name,
          )
        )
          return "";
      }
    }
    scope = scope.__doctorParent;
  }
  return undefined;
}

function declares(patterns: AnyNode[] | undefined, name: string): boolean {
  return (patterns ?? []).some(
    (pattern) =>
      (pattern?.type === "Identifier" && pattern.name === name) ||
      (pattern?.type === "AssignmentPattern" && pattern.left?.name === name),
  );
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
