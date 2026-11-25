import type { RuleContext } from "../../../core/index.js";
import { fileTextScope, type ScriptScope } from "../../../core/internal/script-scope.js";
import { isDevRoute, isNitroHandlerFile, nitroDeployPreset, nitroMajor } from "./nitro-config.js";
import {
  isStorageCall,
  nitroHandlerFunctions,
  reportNode,
  resolvedVariable,
  resolvesToImport,
  unwrapExpression,
  walk,
  walkOwnBody,
} from "./nitro-handlers.js";
import { type AnyNode, createRule } from "./shared.js";

const RULE_ID = "nitro/handler/require-waituntil-for-background-work";

// Presets whose runtime hands event.waitUntil() to the platform. Nitro 2 forwards it from the
// Cloudflare entries only; Nitro 3 also wires Vercel's waitUntil into the request.
const WAITUNTIL_PRESETS: Record<2 | 3, ReadonlySet<string>> = {
  2: new Set([
    "cloudflare-module",
    "cloudflare-module-legacy",
    "cloudflare-pages",
    "cloudflare-durable",
    "cloudflare-worker",
  ]),
  3: new Set(["cloudflare-module", "cloudflare-pages", "cloudflare-durable", "vercel"]),
};
const FETCH_MODULES = new Set(["ofetch", "#imports", "nitropack/runtime"]);
const NITRO_FETCH_MODULES = new Set(["nitro/app"]);
const STORAGE_METHODS = new Set([
  "hasItem",
  "getItem",
  "getItems",
  "getItemRaw",
  "setItem",
  "setItems",
  "setItemRaw",
  "removeItem",
  "getMeta",
  "setMeta",
  "removeMeta",
  "getKeys",
  "clear",
  "dispose",
]);
const PROMISE_CHAIN = new Set(["then", "catch", "finally"]);
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__)\/|\.(?:spec|test)\.[cm]?[jt]sx?$/;

export const requireWaitUntilForBackgroundWork = createRule({
  meta: {
    id: RULE_ID,
    title: "Pass background work to event.waitUntil",
    category: "handler",
    severity: "warn",
    confidence: "heuristic-high",
    fixable: "suggestion",
    docsUrl: "https://nitro.build/deploy/providers/cloudflare",
    requires: { script: true, nitro: true },
    prefilter: { names: ["$fetch", "fetch", "serverFetch", "useStorage", "useKV", "ofetch"] },
  },
  create(ctx) {
    if (!isServerRuntimeFile(ctx) || isDevRoute(ctx, ctx.file.path) || !forwardsWaitUntil(ctx))
      return;
    const major = nitroMajor(ctx);
    return {
      Program() {
        const scope = fileTextScope(ctx);
        if (!scope) return;
        for (const { statement, callee } of floatingPromises(scope, major)) {
          reportNode(
            ctx,
            statement,
            RULE_ID,
            "warn",
            "handler",
            `The handler starts ${callee}() without awaiting it, returning it, or passing it to event.waitUntil(). On ${nitroDeployPreset(ctx)} the platform may stop the isolate or function once the response is sent, so the request or storage write can be cut off without an error.`,
            `Wrap the promise in event.waitUntil(...) so the platform keeps the request alive until it settles, or await it if the response depends on it.`,
          );
        }
      },
    };
  },
});

function isServerRuntimeFile(ctx: RuleContext) {
  const path = ctx.file.relativePath.replace(/\\/g, "/");
  if (TEST_FILE.test(path) || /\.d\.[cm]?ts$/.test(path)) return false;
  return isNitroHandlerFile(ctx, ctx.file.path);
}

function forwardsWaitUntil(ctx: RuleContext) {
  const preset = nitroDeployPreset(ctx);
  if (!preset) return false;
  const major = nitroMajor(ctx);
  if (major === 2 || major === 3) return WAITUNTIL_PRESETS[major].has(preset);
  return WAITUNTIL_PRESETS[2].has(preset) && WAITUNTIL_PRESETS[3].has(preset);
}

function floatingPromises(scope: ScriptScope, major: number | undefined) {
  const found: Array<{ statement: AnyNode; callee: string }> = [];
  const storages = storageBindings(scope);
  for (const handler of nitroHandlerFunctions(scope)) {
    if (handler.body?.type !== "BlockStatement") continue;
    const event = handler.params[0]?.type === "Identifier" ? handler.params[0] : undefined;
    walkOwnBody(scope, handler, (node) => {
      if (node.type !== "ExpressionStatement") return;
      const callee = promiseCallee(scope, node.expression, event, storages, major);
      if (callee) found.push({ statement: node, callee });
    });
  }
  return found;
}

// `const storage = useStorage('data')` anywhere in the file; scope resolution picks the binding.
function storageBindings(scope: ScriptScope) {
  const variables = new Set<unknown>();
  walk(scope, scope.ast, (node) => {
    if (node.type !== "VariableDeclaration" || node.kind !== "const") return;
    for (const declarator of node.declarations) {
      if (declarator.id?.type !== "Identifier" || !isStorageCall(scope, declarator.init)) continue;
      for (const variable of scope.scopeManager.getDeclaredVariables(declarator))
        variables.add(variable);
    }
  });
  return variables;
}

/** The name of the promise-returning call the expression statement starts, if it is one. */
function promiseCallee(
  scope: ScriptScope,
  expression: AnyNode,
  event: AnyNode,
  storages: Set<unknown>,
  major: number | undefined,
): string | undefined {
  let node = unwrapExpression(expression);
  if (node?.type === "UnaryExpression" && node.operator === "void")
    node = unwrapExpression(node.argument);
  while (node?.type === "CallExpression") {
    const callee = unwrapExpression(node.callee);
    if (
      callee?.type === "MemberExpression" &&
      !callee.computed &&
      PROMISE_CHAIN.has(callee.property?.name) &&
      unwrapExpression(callee.object)?.type === "CallExpression"
    ) {
      node = unwrapExpression(callee.object);
      continue;
    }
    break;
  }
  if (node?.type !== "CallExpression") return undefined;
  const callee = unwrapExpression(node.callee);
  if (callee?.type === "Identifier") {
    if (
      resolvesToImport(scope, callee, "$fetch", FETCH_MODULES) ||
      resolvesToImport(scope, callee, "ofetch", FETCH_MODULES)
    )
      return callee.name;
    if (callee.name === "fetch" && !resolvedVariable(scope, callee)) return "fetch";
    if (
      major === 3 &&
      resolvedVariable(scope, callee) &&
      (resolvesToImport(scope, callee, "fetch", NITRO_FETCH_MODULES) ||
        resolvesToImport(scope, callee, "serverFetch", NITRO_FETCH_MODULES))
    )
      return callee.name;
    return undefined;
  }
  if (callee?.type !== "MemberExpression" || callee.computed) return undefined;
  const method = callee.property?.name;
  const object = unwrapExpression(callee.object);
  // $fetch.raw() is the same request with the raw response.
  if (
    method === "raw" &&
    object?.type === "Identifier" &&
    resolvesToImport(scope, object, "$fetch", FETCH_MODULES)
  )
    return "$fetch.raw";
  if (
    major === 2 &&
    (method === "fetch" || method === "$fetch") &&
    event &&
    object?.type === "Identifier" &&
    resolvedVariable(scope, object)?.defs.some((definition: any) => definition.name === event)
  )
    return `${object.name}.${method}`;
  if (!STORAGE_METHODS.has(method)) return undefined;
  if (isStorageCall(scope, object)) return `useStorage().${method}`;
  if (object?.type === "Identifier") {
    const variable = resolvedVariable(scope, object);
    if (variable && storages.has(variable)) return `${object.name}.${method}`;
  }
  return undefined;
}
