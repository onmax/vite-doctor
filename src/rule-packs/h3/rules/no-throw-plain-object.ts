import { nearestFunction, parentOf, propertyKey, unwrapExpression } from "./_errors-helpers.js";
import { type AnyNode, createRule, isH3HandlerFile, isHandlerFunction, report } from "./shared.js";

const ruleId = "h3/errors/no-throw-plain-object";
const statusKeys = new Set(["status", "statusCode"]);

export const noThrowPlainObject = createRule({
  meta: {
    id: "h3/errors/no-throw-plain-object",
    title: "Throw an HTTPError instead of a plain object",
    description:
      "Flags throw statements in H3 handlers that throw an object literal such as { statusCode: 404 }.",
    why: "H3 v2 turns a thrown value that is not an Error into an unhandled 500 and drops its fields. H3 v1 passed it through createError(), so code migrated from v1 that throws { statusCode } now answers every such error with 500.",
    recommendedReplacement:
      'Throw an HTTPError, such as throw new HTTPError({ status: 404, message: "Not found" }) or throw HTTPError.status(404).',
    category: "errors",
    severity: "error",
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://github.com/h3js/h3/blob/main/src/error.ts",
    requires: { script: true },
    applicability: {
      runtimes: { h3: ">=2.0.0-0" },
      includePrerelease: true,
    },
    prefilter: { names: ["status", "statusCode"] },
  },
  create(ctx) {
    if (!isH3HandlerFile(ctx)) return;
    return {
      ThrowStatement(node: AnyNode) {
        const thrown = unwrapExpression(node.argument);
        if (thrown?.type !== "ObjectExpression") return;
        const status = thrown.properties?.find((property: AnyNode) =>
          statusKeys.has(propertyKey(property) ?? ""),
        );
        if (!status) return;
        const handler = nearestFunction(node);
        if (!handler || !isHandlerFunction(ctx, handler)) return;
        if (caughtBefore(node, handler)) return;
        const value = unwrapExpression(status.value);
        const code =
          value?.type === "Literal" && typeof value.value === "number" ? value.value : "status";
        report(
          ctx,
          node,
          ruleId,
          "error",
          "errors",
          "H3 v2 wraps a thrown value that is not an Error in an unhandled HTTPError with status 500, so this object's status and message never reach the client.",
          `Throw an HTTPError instead, such as throw new HTTPError({ status: ${code}, message }) or throw HTTPError.status(${code}).`,
        );
      },
    };
  },
});

/**
 * Whether a `try` between the throw and its handler catches the value and does something other
 * than rethrow it, so the object may never reach H3.
 */
function caughtBefore(node: AnyNode, handler: AnyNode): boolean {
  let child = node;
  for (let current = parentOf(node); current && current !== handler; current = parentOf(current)) {
    if (current.type === "TryStatement" && current.block === child && current.handler) {
      if (!onlyRethrows(current.handler)) return true;
    }
    child = current;
  }
  return false;
}

function onlyRethrows(clause: AnyNode): boolean {
  const body = clause.body?.body ?? [];
  if (body.length === 0) return false;
  if (body.length !== 1 || body[0].type !== "ThrowStatement") return false;
  const thrown = unwrapExpression(body[0].argument);
  return (
    clause.param?.type === "Identifier" &&
    thrown?.type === "Identifier" &&
    thrown.name === clause.param.name
  );
}
