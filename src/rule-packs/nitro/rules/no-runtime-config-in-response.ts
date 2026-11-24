import type { RuleContext } from "../../../core/index.js";
import { fileTextScope, type ScriptScope } from "../../../core/internal/script-scope.js";
import { isNitroHandlerFile } from "./nitro-config.js";
import {
  nitroHandlerFunctions,
  reportNode,
  resolvedVariable,
  resolvesToImport,
  unwrapExpression,
  walk,
  walkOwnBody,
} from "./nitro-handlers.js";
import { type AnyNode, createRule } from "./shared.js";

const RULE_ID = "nitro/runtime/no-runtime-config-in-response";
const RUNTIME_CONFIG_MODULES = new Set([
  "nitropack/runtime",
  "nitro/runtime-config",
  "nitro/runtime",
  "#imports",
  "#internal/nitro",
]);
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__)\/|\.(?:spec|test)\.[cm]?[jt]sx?$/;

export const noRuntimeConfigInResponse = createRule({
  meta: {
    id: RULE_ID,
    title: "Do not send the whole runtime config in a response",
    category: "runtime-config",
    severity: "error",
    confidence: "heuristic-high",
    fixable: "suggestion",
    docsUrl: "https://nitro.build/guide/configuration#runtime-configuration",
    requires: { script: true, nitro: true },
    prefilter: { names: ["useRuntimeConfig"] },
  },
  create(ctx) {
    if (!isServerRuntimeFile(ctx)) return;
    return {
      Program() {
        const scope = fileTextScope(ctx);
        if (!scope) return;
        for (const node of leakedConfigs(scope)) {
          reportNode(
            ctx,
            node,
            RULE_ID,
            "error",
            "runtime-config",
            "This handler sends the object useRuntimeConfig() returns. That object holds every runtimeConfig key, including the private ones Nitro keeps on the server and fills from NITRO_* environment variables, such as API secrets and database URLs, so any client that calls the route can read them.",
            "Return only the fields the client needs, such as config.public.siteUrl. Put values meant for the client under runtimeConfig.public.",
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

function leakedConfigs(scope: ScriptScope): AnyNode[] {
  const isConfigCall = (node: AnyNode) =>
    node?.type === "CallExpression" &&
    resolvesToImport(
      scope,
      unwrapExpression(node.callee),
      "useRuntimeConfig",
      RUNTIME_CONFIG_MODULES,
    );
  // A `const` bound to the whole config. `let` bindings can be reassigned to something safe.
  const configs = new Set<unknown>();
  walk(scope, scope.ast, (node) => {
    if (node.type !== "VariableDeclaration" || node.kind !== "const") return;
    for (const declarator of node.declarations) {
      if (declarator.id?.type !== "Identifier" || !isConfigCall(stripAwait(declarator.init)))
        continue;
      for (const variable of scope.scopeManager.getDeclaredVariables(declarator))
        configs.add(variable);
    }
  });
  const isWholeConfig = (node: AnyNode) =>
    isConfigCall(node) ||
    (node?.type === "Identifier" && configs.has(resolvedVariable(scope, node)));
  const leaks: AnyNode[] = [];
  // Reports only the whole config, a spread of it, or a property set to it that nothing later in
  // the literal can overwrite. Anything less direct stays quiet.
  const leakFromObject = (object: AnyNode) => {
    object.properties.forEach((property: AnyNode, index: number) => {
      if (property.type === "SpreadElement") {
        if (isWholeConfig(stripAwait(property.argument))) leaks.push(property.argument);
        return;
      }
      if (!isWholeConfig(stripAwait(property.value))) return;
      const key = staticKey(property);
      const later = object.properties.slice(index + 1);
      const kept = later.every(
        (next: AnyNode) => next.type !== "SpreadElement" && (staticKey(next) ?? key) !== key,
      );
      if (key !== undefined && kept) leaks.push(property.value);
    });
  };
  const leak = (value: AnyNode) => {
    let node = stripAwait(value);
    // new Response(object) sends "[object Object]"; only a stringified config leaks through it.
    if (node?.type === "NewExpression" && isGlobal(scope, node.callee, "Response")) {
      node = stripAwait(node.arguments[0]);
      if (node?.type !== "CallExpression" || !isStringify(scope, node)) return;
    }
    if (
      node?.type === "CallExpression" &&
      (isStringify(scope, node) || isGlobalMethod(scope, node, "Response", "json"))
    )
      node = stripAwait(node.arguments[0]);
    if (isWholeConfig(node)) leaks.push(node);
    else if (node?.type === "ObjectExpression") leakFromObject(node);
  };
  for (const handler of nitroHandlerFunctions(scope)) {
    if (handler.body?.type !== "BlockStatement") {
      leak(handler.body);
      continue;
    }
    walkOwnBody(scope, handler, (node) => {
      if (node.type === "ReturnStatement") leak(node.argument);
    });
  }
  return leaks;
}

function staticKey(property: AnyNode): string | undefined {
  if (property.computed) return undefined;
  if (property.key.type === "Identifier") return property.key.name;
  const value = property.key.type === "Literal" ? property.key.value : undefined;
  if (typeof value === "string" || typeof value === "number") return String(value);
  return undefined;
}

function isStringify(scope: ScriptScope, call: AnyNode) {
  const replacer = unwrapExpression(call.arguments[1]);
  const unfiltered =
    !replacer ||
    (replacer.type === "Literal" && replacer.value === null) ||
    isGlobal(scope, replacer, "undefined");
  return unfiltered && isGlobalMethod(scope, call, "JSON", "stringify");
}

function isGlobalMethod(scope: ScriptScope, call: AnyNode, object: string, method: string) {
  const callee = unwrapExpression(call.callee);
  return (
    callee?.type === "MemberExpression" &&
    !callee.computed &&
    callee.property?.name === method &&
    isGlobal(scope, callee.object, object)
  );
}

function isGlobal(scope: ScriptScope, node: AnyNode, name: string) {
  return node?.type === "Identifier" && node.name === name && !resolvedVariable(scope, node);
}

function stripAwait(node: AnyNode): AnyNode {
  let current = unwrapExpression(node);
  while (current?.type === "AwaitExpression") current = unwrapExpression(current.argument);
  return current;
}
