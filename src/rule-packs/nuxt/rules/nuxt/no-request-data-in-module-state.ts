import type { RuleContext } from "../../../../core/index.js";
import { holdsRequestValue, unwrapExpression } from "../../../../core/internal/request-values.js";
import {
  blockRange,
  importedName,
  inRange,
  isRequestTimeWrite,
  moduleScriptRange,
  resolvesToModuleState,
  setupBinding,
  type SourceRange,
} from "./module-scope-state.js";
import {
  type AnyNode,
  classifyExecutionEvidence,
  createRule,
  isClientOnlyPath,
  isRuntimeAppFile,
  report,
  walkScriptLocal,
} from "./shared.js";

const RULE_ID = "nuxt/ssr/no-request-data-in-module-state";
const STATE_FACTORIES = new Map<string, Shape>([
  ["ref", "ref"],
  ["shallowRef", "ref"],
  ["reactive", "object"],
  ["shallowReactive", "object"],
]);
const VUE_SOURCES = /^(?:vue|@vue\/(?:reactivity|runtime-core))$/;
const NUXT_SOURCES = /^(?:#app(?:\/.*)?|nuxt\/app)$/;
// Composables whose result describes the request being rendered. Nuxt auto-imports them from
// #app/composables/{router,ssr,cookie}.
const REQUEST_COMPOSABLES = new Set([
  "useRoute",
  "useRequestEvent",
  "useRequestHeaders",
  "useRequestHeader",
  "useRequestURL",
  "useCookie",
]);
const ARRAY_MUTATORS = new Set(["push", "unshift", "splice", "fill"]);
const SERVER_EVIDENCE = new Set(["setup-time", "unknown"]);

type Shape = "ref" | "object";

interface StateBinding {
  name: string;
  shape: Shape;
  declarator: AnyNode;
  write?: AnyNode;
}

export const noRequestDataInModuleState = createRule({
  meta: {
    id: RULE_ID,
    title: "Keep request data out of module-scope state",
    category: "ssr",
    severity: "warn",
    confidence: "heuristic-high",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/getting-started/state-management#best-practices",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!rendersOnServer(ctx)) return;
    if (isClientOnlyPath(ctx.file.relativePath) || !isRuntimeAppFile(ctx)) return;
    return {
      Program(program: AnyNode) {
        const bindings = stateBindings(ctx, program);
        if (!bindings.size) return;
        const setup = blockRange(ctx, "scriptSetup");
        walkScriptLocal(program, (node) => {
          if (node.type !== "Identifier") return;
          const binding = bindings.get(node.name);
          if (!binding || binding.write || node === binding.declarator.id) return;
          if (!resolvesToModuleState(node, program, setup)) return;
          const values = writtenValues(node, binding.shape);
          if (!values.length || !isServerWrite(ctx, node, setup)) return;
          if (values.some((value) => holdsRequestValue(value, requestSources(ctx, setup))))
            binding.write = node;
        });
        for (const binding of bindings.values()) {
          if (!binding.write) continue;
          const line = ctx.range(binding.write)?.line;
          report(
            ctx,
            binding.declarator.id,
            RULE_ID,
            "warn",
            "ssr",
            `${binding.name} is created once at module scope, and code that runs during server rendering${line ? ` on line ${line}` : ""} writes request data (route, headers, cookies, or the request event) into it. Nuxt evaluates this module once per server process and renders every request against the same instance, so concurrent requests overwrite each other's value and one user's data can render for another.`,
            "Create state per request in local variables or with setup-local ref()/reactive(). Keep credentials and request objects in server-only request context. Use useState() only for serializable values that belong in the hydration payload and are safe to send to the browser.",
          );
        }
      },
    };
  },
});

function rendersOnServer(ctx: RuleContext) {
  const nuxt = ctx.project.nuxt;
  return ctx.project.ssr && nuxt?.ssr !== false;
}

function stateBindings(ctx: RuleContext, program: AnyNode) {
  const bindings = new Map<string, StateBinding>();
  const moduleScript = moduleScriptRange(ctx);
  if (!moduleScript) return bindings;
  for (const statement of program.body ?? []) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type !== "VariableDeclaration") continue;
    if (!inRange(statement, moduleScript)) continue;
    for (const declarator of declaration.declarations) {
      if (declarator.id?.type !== "Identifier") continue;
      const shape = stateShape(ctx, declarator.init);
      if (shape)
        bindings.set(declarator.id.name, {
          name: declarator.id.name,
          shape,
          declarator,
        });
    }
  }
  return bindings;
}

// Map and Set state belongs to NUXT0084, which reports it with a broader notion of request data.
function stateShape(ctx: RuleContext, input: AnyNode): Shape | null {
  const init = unwrapExpression(input);
  if (init?.type === "ObjectExpression" || init?.type === "ArrayExpression") return "object";
  if (init?.type !== "CallExpression") return null;
  const name = importedName(ctx, init.callee, (source) => VUE_SOURCES.test(source));
  return name ? (STATE_FACTORIES.get(name) ?? null) : null;
}

/** Values written into the state through `reference`, not counting a reassignment of the binding. */
function writtenValues(reference: AnyNode, shape: Shape): AnyNode[] {
  const path: AnyNode[] = [];
  let target = reference;
  while (
    target.__doctorParent?.type === "MemberExpression" &&
    target.__doctorParent.object === target
  ) {
    target = target.__doctorParent;
    path.push(target);
  }
  const reachesState = (depth: number) =>
    shape === "object" || (depth >= 1 && !path[0].computed && path[0].property?.name === "value");
  const parent = target.__doctorParent;
  if (parent?.type === "AssignmentExpression" && parent.left === target && path.length) {
    return reachesState(path.length) ? [parent.right] : [];
  }
  const last = path.at(-1);
  if (
    last &&
    !last.computed &&
    ARRAY_MUTATORS.has(last.property?.name) &&
    parent?.type === "CallExpression" &&
    parent.callee === target &&
    (shape === "object" || path.length >= 2) &&
    reachesState(path.length - 1)
  )
    return parent.arguments ?? [];
  const call = target.__doctorParent;
  if (
    call?.type === "CallExpression" &&
    call.arguments?.[0] === target &&
    isObjectAssign(call.callee) &&
    (shape === "object" ? true : reachesState(path.length))
  )
    return call.arguments.slice(1);
  return [];
}

function isObjectAssign(callee: AnyNode) {
  const node = unwrapExpression(callee);
  return (
    node?.type === "MemberExpression" &&
    !node.computed &&
    node.object?.type === "Identifier" &&
    node.object.name === "Object" &&
    node.property?.name === "assign"
  );
}

function isServerWrite(ctx: RuleContext, node: AnyNode, setup: SourceRange | null) {
  const watcherExecution = (callback: AnyNode) => runsDuringSsr(ctx, callback);
  return (
    isRequestTimeWrite(ctx, node, setup, (callback) => watcherExecution(callback) === true) &&
    SERVER_EVIDENCE.has(classifyExecutionEvidence(ctx, node, watcherExecution))
  );
}

function runsDuringSsr(ctx: RuleContext, callback: AnyNode): boolean | undefined {
  if (callback?.type !== "FunctionExpression" && callback?.type !== "ArrowFunctionExpression")
    return;
  const call = callback.__doctorParent;
  if (call?.type !== "CallExpression" || !call.arguments.includes(callback)) return;
  const name = importedName(ctx, unwrapExpression(call.callee), (source) =>
    VUE_SOURCES.test(source),
  );
  if (name === "watch") {
    if (call.arguments?.[1] !== callback) return false;
    const options = unwrapExpression(call.arguments[2]);
    return option(options, "immediate") === true;
  }
  if (name === "watchPostEffect") return false;
  if (name === "watchSyncEffect") return true;
  if (name === "watchEffect") {
    const options = unwrapExpression(call.arguments?.[1]);
    const flush = option(options, "flush");
    return flush === undefined || flush === "pre" || flush === "sync";
  }
}

function option(options: AnyNode, name: string): unknown {
  if (!options) return undefined;
  if (options.type !== "ObjectExpression") return null;
  const property = options.properties.findLast(
    (item: AnyNode) =>
      item.type === "SpreadElement" ||
      item.computed ||
      (item.key?.name ?? item.key?.value) === name,
  );
  if (!property) return undefined;
  return property.type === "Property" && !property.computed
    ? (unwrapExpression(property.value)?.value ?? null)
    : null;
}

function requestSources(ctx: RuleContext, setup: SourceRange | null) {
  return {
    isSource: (node: AnyNode) =>
      node.type === "CallExpression" && isRequestComposableCall(ctx, node),
    programBinding: (program: AnyNode, name: string, reference: AnyNode) =>
      inRange(reference, setup) ? setupBinding(program, name, setup) : null,
    // The route a route middleware receives is the one the server is rendering.
    parameter: (fn: AnyNode, index: number) => index <= 1 && isRouteMiddlewareCallback(ctx, fn),
  };
}

function isRequestComposableCall(ctx: RuleContext, call: AnyNode) {
  const callee = unwrapExpression(call.callee);
  const name = importedName(
    ctx,
    callee,
    (source) =>
      NUXT_SOURCES.test(source) || (callee?.name === "useRoute" && source === "vue-router"),
  );
  return Boolean(name && REQUEST_COMPOSABLES.has(name));
}

function isRouteMiddlewareCallback(ctx: RuleContext, fn: AnyNode) {
  const call = fn.__doctorParent;
  return (
    call?.type === "CallExpression" &&
    unwrapExpression(call.arguments?.[0]) === fn &&
    importedName(ctx, unwrapExpression(call.callee), (source) => NUXT_SOURCES.test(source)) ===
      "defineNuxtRouteMiddleware"
  );
}
