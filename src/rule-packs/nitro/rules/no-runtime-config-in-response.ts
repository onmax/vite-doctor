import type { RuleContext } from "../../../core/index.js";
import { fileTextScope, type ScriptScope } from "../../../core/internal/script-scope.js";
import {
  nitroHandlerFunctions,
  reportNode,
  resolvedVariable,
  resolvesToImport,
  unwrapExpression,
  walk,
  walkOwnBody,
} from "./nitro-handlers.js";
import { nitroServerFile } from "./server-layout.js";
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
  return Boolean(nitroServerFile(ctx, ctx.file.path)) && !/\.config\.[cm]?[jt]s$/.test(path);
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
  const leaks: AnyNode[] = [];
  const leak = (value: AnyNode): void => {
    const node = stripAwait(value);
    if (!node) return;
    if (isConfigCall(node)) return void leaks.push(node);
    if (node.type === "Identifier") {
      const variable = resolvedVariable(scope, node);
      if (variable && configs.has(variable)) leaks.push(node);
      return;
    }
    if (node.type === "ObjectExpression") {
      for (const property of node.properties)
        leak(property.type === "SpreadElement" ? property.argument : property.value);
      return;
    }
    if (node.type === "ArrayExpression") {
      for (const element of node.elements)
        leak(element?.type === "SpreadElement" ? element.argument : element);
      return;
    }
    if (node.type === "ConditionalExpression") {
      leak(node.consequent);
      leak(node.alternate);
      return;
    }
    if (node.type === "LogicalExpression") {
      leak(node.left);
      leak(node.right);
      return;
    }
    if (node.type === "CallExpression" && isSerializer(scope, node)) leak(node.arguments[0]);
    // new Response(object) sends "[object Object]"; only a serialized config leaks through it.
    if (
      node.type === "NewExpression" &&
      isGlobal(scope, node.callee, "Response") &&
      stripAwait(node.arguments[0])?.type === "CallExpression" &&
      isSerializer(scope, stripAwait(node.arguments[0]))
    )
      leak(node.arguments[0]);
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

// JSON.stringify(config) and Response.json(config) serialize every key of the object.
function isSerializer(scope: ScriptScope, call: AnyNode) {
  const callee = unwrapExpression(call.callee);
  if (callee?.type !== "MemberExpression" || callee.computed) return false;
  const method = callee.property?.name;
  return (
    (method === "stringify" && isGlobal(scope, callee.object, "JSON")) ||
    (method === "json" && isGlobal(scope, callee.object, "Response"))
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
