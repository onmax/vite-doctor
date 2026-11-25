import type { RuleContext } from "../../../core/index.js";
import {
  isFunctionNode,
  isNeverReassigned,
  memberName,
  nearestFunction,
  propertyKey,
  resolveVariable,
  unwrapExpression,
} from "./_errors-helpers.js";
import {
  type AnyNode,
  createRule,
  handlerFor,
  h3ExportName,
  canUseNativeH3,
  isH3HandlerFile,
  isHandlerEvent,
  report,
} from "./shared.js";

const ruleId = "h3/body/no-double-body-read";
const readUtils = new Set([
  "readBody",
  "readValidatedBody",
  "readRawBody",
  "readFormData",
  "readFormDataBody",
  "readMultipartFormData",
]);
// h3 v2 `sendProxy` is `proxy`, which never forwards the incoming body; only `proxyRequest` does.
const proxyUtils = new Set(["proxyRequest"]);
const requestReads = new Set(["json", "text", "formData", "arrayBuffer", "blob", "bytes"]);

interface BodyUse {
  node: AnyNode;
  event: unknown;
  label: string;
  proxy: boolean;
}

export const noDoubleBodyRead = createRule({
  meta: {
    id: "h3/body/no-double-body-read",
    title: "Read the request body once",
    description:
      "Flags a handler that reads the request body twice, or reads it and then proxies the request.",
    why: "H3 v2 uses the Web Request stream. If a body is present and the first read consumes it, a second read can fail and the original stream can no longer be forwarded by a proxy.",
    recommendedReplacement:
      "Read the body once and reuse it, or read from a clone before forwarding the original stream to a proxy.",
    category: "body",
    severity: "error",
    confidence: "heuristic-high",
    fixable: "suggestion",
    docsUrl: "https://github.com/h3js/h3/issues/1212",
    requires: { script: true },
    applicability: {
      runtimes: { h3: ">=2.0.0-0" },
      includePrerelease: true,
    },
    prefilter: { names: [...readUtils, ...proxyUtils, ...requestReads] },
  },
  create(ctx) {
    if (!isH3HandlerFile(ctx)) return;
    const checkBlock = (statements: readonly AnyNode[]) => {
      const reads = new Map<unknown, BodyUse>();
      for (const statement of statements) {
        for (const use of statementBodyUses(ctx, statement)) {
          const earlier = reads.get(use.event);
          if (!earlier) {
            if (!use.proxy) reads.set(use.event, use);
            continue;
          }
          report(
            ctx,
            use.node,
            ruleId,
            "error",
            "body",
            use.proxy
              ? `If ${earlier.label} consumes the request body, ${use.label} cannot forward the original stream and can fail.`
              : `If ${earlier.label} consumes the request body, ${use.label} can fail because H3 v2 can read the stream only once.`,
            use.proxy
              ? "Read from event.req.clone() before proxying so the original stream is still available."
              : "Read the body once into a variable and reuse it, or make the extra read from event.req.clone() before the first one.",
          );
        }
      }
    };
    return {
      Program(node: AnyNode) {
        checkBlock(node.body ?? []);
      },
      BlockStatement(node: AnyNode) {
        checkBlock(node.body ?? []);
      },
      SwitchCase(node: AnyNode) {
        checkBlock(node.consequent ?? []);
      },
    };
  },
});

/**
 * The body reads and proxies a statement always runs, in evaluation order. Nested statements,
 * conditional operands, optional chains, and nested functions are left out: their code may not
 * run, or forms a block the Rule checks on its own.
 */
function statementBodyUses(ctx: RuleContext, statement: AnyNode): BodyUse[] {
  const roots: AnyNode[] = [];
  if (statement?.type === "ExpressionStatement") roots.push(statement.expression);
  else if (statement?.type === "VariableDeclaration")
    for (const declarator of statement.declarations ?? []) roots.push(declarator.init);
  else if (statement?.type === "ReturnStatement" || statement?.type === "ThrowStatement")
    roots.push(statement.argument);
  const uses: BodyUse[] = [];
  const visit = (node: AnyNode) => {
    if (!node || typeof node.type !== "string" || isFunctionNode(node)) return;
    if (node.type === "ClassExpression" || node.type === "ChainExpression") return;
    if (node.type === "ConditionalExpression") return visit(node.test);
    if (node.type === "LogicalExpression") return visit(node.left);
    if (node.type === "CallExpression") {
      visit(node.callee);
      for (const argument of node.arguments ?? []) visit(argument);
      const use = bodyUse(ctx, node);
      if (use) uses.push(use);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "__doctorParent" || key === "parent") continue;
      if (Array.isArray(value)) for (const item of value) visit(item);
      else if (value && typeof value === "object") visit(value);
    }
  };
  for (const root of roots) visit(root);
  return uses;
}

function bodyUse(ctx: RuleContext, call: AnyNode): BodyUse | undefined {
  const handler = handlerFor(ctx, nearestFunction(call));
  if (handler?.bodyless) return undefined;
  const name = h3ExportName(ctx, call.callee);
  if (name && (readUtils.has(name) || proxyUtils.has(name))) {
    if (!canUseNativeH3(ctx, call.callee)) return undefined;
    const event = eventBinding(ctx, call.arguments?.[0]);
    if (!event) return undefined;
    const proxy = proxyUtils.has(name);
    if (proxy && !forwardsIncomingBody(call.arguments?.[2])) return undefined;
    return { node: call, event, label: `${name}()`, proxy };
  }
  const callee = unwrapExpression(call.callee);
  const method = memberName(callee);
  if (!method || !requestReads.has(method)) return undefined;
  const request = unwrapExpression(callee.object);
  if (
    (ctx.project.runtimeGraph?.nuxtH3MayBeShimmed && !handler?.native) ||
    memberName(request) !== "req" ||
    !isHandlerEvent(ctx, request.object)
  )
    return undefined;
  const event = eventBinding(ctx, request.object);
  const label = `${unwrapExpression(request.object).name}.req.${method}()`;
  return event ? { node: call, event, label, proxy: false } : undefined;
}

function eventBinding(ctx: RuleContext, node: AnyNode): unknown {
  const variable = resolveVariable(ctx, unwrapExpression(node));
  return variable && isNeverReassigned(variable) ? variable : undefined;
}

/** Whether `proxyRequest()` options leave the incoming body as the one it forwards. */
function forwardsIncomingBody(options: AnyNode): boolean {
  const value = unwrapExpression(options);
  if (!value) return true;
  if (value.type !== "ObjectExpression") return false;
  for (const property of value.properties ?? []) {
    const key = propertyKey(property);
    if (!key) return false;
    if (key !== "fetchOptions") continue;
    const fetchOptions = unwrapExpression(property.value);
    if (fetchOptions?.type !== "ObjectExpression") return false;
    for (const option of fetchOptions.properties ?? []) {
      const name = propertyKey(option);
      if (!name || name === "body" || name === "method") return false;
    }
  }
  return true;
}
