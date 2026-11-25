import {
  type AnyNode,
  createRule,
  isH3Call,
  isH3HandlerFile,
  isHandlerEvent,
  isHandlerFunction,
  nearestFunctionOrProgram,
  report,
} from "./shared.js";
import type { RuleContext } from "../../../core/index.js";
import { fileScriptScope, perFile } from "../../../core/internal/script-scope.js";

type Field = "status" | "statusText";

function reportLost(ctx: RuleContext, node: AnyNode, lost: Field[]) {
  const fields = lost.join(" and ");
  report(
    ctx,
    node,
    "h3/response/no-prepared-status-with-response",
    "warn",
    "response",
    `This handler returns a Response, and H3 v2 keeps a returned Response's own ${fields}, so the ${fields} prepared here is dropped. Prepared headers are still merged in.`,
    `Pass it to the Response instead, such as new Response(body, { ${lost.map((field) => `${field}: ...`).join(", ")} }), and remove this line.`,
  );
}

/**
 * The init fields of a returned `new Response(body, init?)` or `Response.json(data, init?)`, or
 * undefined when the value is something else or its init can't be read.
 */
function responseInit(ctx: RuleContext, node: AnyNode): Set<string> | undefined {
  const value = unwrap(node);
  if (value?.type !== "NewExpression" && value?.type !== "CallExpression") return;
  const callee = unwrap(value.callee);
  const isConstructor = value.type === "NewExpression" && isName(callee, "Response");
  const isJson =
    value.type === "CallExpression" &&
    callee?.type === "MemberExpression" &&
    !callee.computed &&
    isName(callee.object, "Response") &&
    isName(callee.property, "json");
  if (!isConstructor && !isJson) return;
  if (responseShadowed(ctx)) return;
  const init = unwrap(value.arguments?.[1]);
  if (!init) return new Set();
  if (init.type !== "ObjectExpression") return;
  const keys = new Set<string>();
  for (const property of init.properties) {
    if (property.type !== "Property" || property.computed) return;
    const key = property.key?.type === "Identifier" ? property.key.name : property.key?.value;
    keys.add(String(key));
  }
  return keys;
}

function responseShadowed(ctx: RuleContext): boolean {
  return perFile(ctx, "h3:response-shadowed", () => {
    const scope = fileScriptScope(ctx);
    if (!scope) return true;
    return scope.scopeManager.scopes.some(
      (item) => item.type !== "global" && item.set.has("Response"),
    );
  });
}

/** The status fields a statement prepares on the handler's event, or null if it prepares none. */
function preparedFields(ctx: RuleContext, statement: AnyNode): Field[] | null {
  if (statement.type !== "ExpressionStatement") return null;
  const expression = unwrap(statement.expression);
  if (expression?.type === "AssignmentExpression") {
    const target = unwrap(expression.left);
    if (target?.type !== "MemberExpression" || target.computed) return null;
    const field = target.property?.name;
    if (field !== "status" && field !== "statusText") return null;
    const res = unwrap(target.object);
    if (res?.type !== "MemberExpression" || res.computed || res.property?.name !== "res")
      return null;
    if (!isHandlerEvent(ctx, res.object)) return null;
    return field === "status" && isDefaultStatus(expression.right) ? [] : [field];
  }
  if (!isH3Call(ctx, expression, ["setResponseStatus"])) return null;
  const [event, code, text] = expression.arguments;
  if (!isHandlerEvent(ctx, event)) return null;
  const fields: Field[] = [];
  if (code && !isDefaultStatus(code)) fields.push("status");
  if (text) fields.push("statusText");
  return fields;
}

// A Response already defaults to 200, so preparing 200 loses nothing.
function isDefaultStatus(node: AnyNode): boolean {
  const value = unwrap(node);
  return value?.type === "Literal" && value.value === 200;
}

function containsReturn(node: AnyNode): boolean {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(containsReturn);
  if (node.type === "ReturnStatement") return true;
  if (functionTypes.has(node.type)) return false;
  for (const [key, value] of Object.entries(node)) {
    if (key === "__doctorParent" || key === "parent") continue;
    if (value && typeof value === "object" && containsReturn(value)) return true;
  }
  return false;
}

const functionTypes = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

function isName(node: AnyNode, name: string): boolean {
  return node?.type === "Identifier" && node.name === name;
}

function parentOf(node: AnyNode): AnyNode {
  return node?.__doctorParent ?? node?.parent;
}

function unwrap(node: AnyNode): AnyNode {
  let current = node;
  while (
    current?.type === "AwaitExpression" ||
    current?.type === "ParenthesizedExpression" ||
    current?.type === "TSAsExpression" ||
    current?.type === "TSSatisfiesExpression" ||
    current?.type === "TSNonNullExpression"
  )
    current = current.type === "AwaitExpression" ? current.argument : current.expression;
  return current;
}

export const noPreparedStatusWithResponse = createRule({
  meta: {
    id: "h3/response/no-prepared-status-with-response",
    title: "Set the status on the Response you return",
    description:
      "Flags a status set through event.res.status or setResponseStatus() in a handler that returns a Response.",
    why: "H3 v2 applies a prepared event.res.status only to plain return values. A returned Response keeps its own status, so the prepared status is silently ignored and the client gets 200.",
    recommendedReplacement:
      "Pass the status to the Response, such as new Response(body, { status: 201 }), or return a plain value instead.",
    category: "response",
    severity: "warn",
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://github.com/h3js/h3/blob/main/src/response.ts",
    requires: { script: true },
    applicability: {
      runtimes: { h3: ">=2.0.0-0" },
      includePrerelease: true,
    },
  },
  create(ctx) {
    if (!isH3HandlerFile(ctx) || !/\bResponse\b/.test(ctx.file.text)) return;
    return {
      ReturnStatement(node: AnyNode) {
        const init = responseInit(ctx, node.argument);
        if (init === undefined) return;
        const block = parentOf(node);
        if (block?.type !== "BlockStatement") return;
        if (!isHandlerFunction(ctx, nearestFunctionOrProgram(node))) return;
        const statements: AnyNode[] = block.body;
        for (let index = statements.indexOf(node) - 1; index >= 0; index--) {
          const statement = statements[index];
          const prepared = preparedFields(ctx, statement);
          if (prepared) {
            const lost = prepared.filter((field) => !init.has(field));
            if (lost.length) reportLost(ctx, statement, lost);
            return;
          }
          if (containsReturn(statement)) return;
        }
      },
    };
  },
});
