import type { RuleContext } from "../../../core/index.js";
import { fileTextScope, type ScriptScope } from "../../../core/internal/script-scope.js";
import { isNitroHandlerFile } from "./nitro-config.js";
import {
  constInitializer,
  nitroHandlerFunctions,
  reportNode,
  resolvedVariable,
  resolvesToImport,
  unwrapExpression,
  walk,
  walkOwnBody,
} from "./nitro-handlers.js";
import { propertyKey } from "./server-layout.js";
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
  const expanding = new Set<AnyNode>();
  const leak = (value: AnyNode, directResponse = false): void => {
    const node = stripAwait(value);
    if (!node) return;
    if (isWholeConfig(node)) return void leaks.push(node);
    if (node.type === "ObjectExpression") {
      const visitProperties = (object: AnyNode, overwritten: Set<string>) => {
        if (expanding.has(object)) return;
        expanding.add(object);
        for (const property of [...object.properties].reverse()) {
          if (property.type === "SpreadElement") {
            const argument = stripAwait(property.argument);
            const initializer = stripAwait(constInitializer(scope, argument));
            if (argument?.type === "ObjectExpression") visitProperties(argument, overwritten);
            else if (initializer?.type === "ObjectExpression")
              visitProperties(initializer, new Set(overwritten));
            else leak(argument);
            continue;
          }
          const key = property.computed
            ? property.key.type === "Literal"
              ? propertyKey(property.key)
              : null
            : propertyKey(property.key);
          if (key === null || !overwritten.has(key)) leak(property.value);
          if (key !== null) overwritten.add(key);
        }
        expanding.delete(object);
      };
      visitProperties(node, new Set());
      return;
    }
    if (node.type === "ArrayExpression") {
      for (const element of node.elements)
        leak(element?.type === "SpreadElement" ? element.argument : element);
      return;
    }
    if (node.type === "ConditionalExpression") {
      leak(node.consequent, directResponse);
      leak(node.alternate, directResponse);
      return;
    }
    if (node.type === "LogicalExpression") {
      if (node.operator !== "&&") leak(node.left, directResponse);
      if (node.operator === "&&" || !isWholeConfig(stripAwait(node.left)))
        leak(node.right, directResponse);
      return;
    }
    if (node.type === "CallExpression" && isSerializer(scope, node, directResponse))
      leak(node.arguments[0]);
    // new Response(object) sends "[object Object]"; only a serialized config leaks through it.
    if (
      node.type === "NewExpression" &&
      isGlobal(scope, node.callee, "Response") &&
      stripAwait(node.arguments[0])?.type === "CallExpression" &&
      isSerializer(scope, stripAwait(node.arguments[0]), false)
    )
      leak(node.arguments[0]);
  };
  for (const handler of nitroHandlerFunctions(scope)) {
    if (handler.body?.type !== "BlockStatement") {
      leak(handler.body, true);
      continue;
    }
    walkOwnBody(scope, handler, (node) => {
      if (node.type === "ReturnStatement") leak(node.argument, true);
    });
  }
  return leaks;
}

function isSerializer(scope: ScriptScope, call: AnyNode, directResponse: boolean) {
  const callee = unwrapExpression(call.callee);
  if (callee?.type !== "MemberExpression" || callee.computed) return false;
  const method = callee.property?.name;
  const replacer = unwrapExpression(call.arguments[1]);
  const hasStaticAllowlist =
    replacer?.type === "ArrayExpression" &&
    replacer.elements.every(
      (element: AnyNode) =>
        element?.type === "Literal" &&
        (typeof element.value === "string" || typeof element.value === "number"),
    );
  return (
    (method === "stringify" && isGlobal(scope, callee.object, "JSON") && !hasStaticAllowlist) ||
    (directResponse && method === "json" && isGlobal(scope, callee.object, "Response"))
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
