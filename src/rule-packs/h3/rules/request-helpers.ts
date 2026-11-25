import { fileTextScope } from "../../../core/internal/script-scope.js";
import {
  type AnyNode,
  createRule,
  h3ExportName,
  isH3Call,
  isH3HandlerFile,
  nearestFunctionOrProgram,
  report,
  sourceForNode,
  walkScriptLocal,
} from "./shared.js";

import type { Confidence, RuleContext } from "../../../core/index.js";

export interface RawInputMatch {
  node: AnyNode;
  variable: string;
  rawUtility: string;
  validatedUtility: string;
}

export interface ValidatedInputRuleOptions {
  id: string;
  title: string;
  description: string;
  rawUtilities: string[];
  validatedUtility: string;
  message: string;
  suggestion: string;
  confidence: Confidence;
  docsUrl?: string;
}

export interface MethodCheck {
  method: string;
  operator: "===" | "==" | "!==" | "!=";
  isNegative: boolean;
}

export function createValidatedInputRule(opts: ValidatedInputRuleOptions) {
  return createRule({
    meta: {
      id: opts.id,
      title: opts.title,
      description: opts.description,
      recommendedReplacement: `Use ${opts.validatedUtility}(event, validator) instead of ${opts.rawUtilities[0]}(event) followed by separate validation.`,
      category: "request",
      severity: "warn",
      confidence: opts.confidence,
      fixable: "suggestion",
      docsUrl: opts.docsUrl,
      requires: { script: true },
    },
    create(ctx) {
      if (!isH3HandlerFile(ctx)) return;
      let bindings: Map<number, Set<number>> | undefined;
      return {
        VariableDeclarator(node: AnyNode) {
          if (!rawInputVariable(ctx, node, opts.rawUtilities)) return;
          const match = rawInputValidatedNearby(
            ctx,
            node,
            opts.rawUtilities,
            opts.validatedUtility,
            (bindings ??= variableReferences(ctx)),
          );
          if (!match) return;
          report(ctx, match.node, opts.id, "warn", "request", opts.message, opts.suggestion);
        },
      };
    },
  });
}

export function rawInputValidatedNearby(
  ctx: RuleContext,
  node: AnyNode,
  rawUtilities: string[],
  validatedUtility: string,
  bindings: Map<number, Set<number>>,
): RawInputMatch | null {
  const variable = rawInputVariable(ctx, node, rawUtilities);
  if (!variable) return null;
  const scope = nearestFunctionOrProgram(node);
  const references = bindings.get(node.id.start);
  if (
    !scope ||
    !references ||
    !hasValidationOfVariable(scope, references, ctx.file.text, node.start ?? 0)
  )
    return null;
  return {
    node,
    variable,
    rawUtility: h3ExportName(ctx, unwrapAwait(node.init).callee) ?? "",
    validatedUtility,
  };
}

const ipHeaders = new Set([
  "x-forwarded-for",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "x-client-ip",
]);

/**
 * A read of a client IP header: `getHeader(event, name)` or `getRequestHeader(event, name)` from
 * h3, or `event.req.headers.get(name)` on the H3 v2 request.
 */
export function isIpHeaderRead(ctx: RuleContext, node: AnyNode) {
  if (node.type !== "CallExpression") return false;
  const argument = isH3Call(ctx, node, ["getHeader", "getRequestHeader"])
    ? node.arguments?.[1]
    : isRequestHeadersGet(node.callee)
      ? node.arguments?.[0]
      : undefined;
  const header = argument && staticString(argument, ctx.file.text)?.toLowerCase();
  return Boolean(header && ipHeaders.has(header));
}

function isRequestHeadersGet(callee: AnyNode) {
  const headers = callee?.type === "MemberExpression" && !callee.computed ? callee.object : null;
  const request = headers?.type === "MemberExpression" && !headers.computed ? headers.object : null;
  return (
    callee?.property?.name === "get" &&
    headers?.property?.name === "headers" &&
    request?.type === "MemberExpression" &&
    !request.computed &&
    request.property?.name === "req"
  );
}

export function isRequestSensitiveUse(ctx: RuleContext, node: AnyNode) {
  const scope = nearestFunctionOrProgram(node) ?? node;
  const text = sourceForNode(scope, ctx.file.text);
  return /\b(?:rateLimit|rateLimiter|ipLimit|throttle|ban|blockIp|allowIp|denyIp|ipAllow|ipDeny|ipBlock|ipBan|blacklist|whitelist)\b/i.test(
    text,
  );
}

export function singleMethodCheck(
  node: AnyNode,
  source: string,
  anchor: AnyNode = node,
): MethodCheck | null {
  if (node.type !== "BinaryExpression") return null;
  const operator = node.operator;
  if (operator !== "===" && operator !== "==" && operator !== "!==" && operator !== "!=")
    return null;
  const leftMethod = methodExpressionName(node.left, source, anchor);
  const rightMethod = methodExpressionName(node.right, source, anchor);
  const method = staticString(node.left, source) ?? staticString(node.right, source);
  if (!method || (!leftMethod && !rightMethod)) return null;
  const normalized = method.toUpperCase();
  if (!isHttpMethod(normalized)) return null;
  return { method: normalized, operator, isNegative: operator === "!==" || operator === "!=" };
}

export function isSingleMethodCheck(node: AnyNode, source: string, anchor: AnyNode = node) {
  return singleMethodCheck(node, source, anchor)?.method ?? null;
}

export function methodChecks(node: AnyNode, source: string, anchor: AnyNode = node) {
  const checks = new Map<string, MethodCheck>();
  walkScriptLocal(node, (child) => {
    const check = singleMethodCheck(child, source, anchor);
    if (check) checks.set(`${check.method}:${check.operator}`, check);
  });
  return [...checks.values()];
}

export function methodCheckMethods(node: AnyNode, source: string, anchor: AnyNode = node) {
  return [...new Set(methodChecks(node, source, anchor).map((check) => check.method))];
}

function rawInputVariable(ctx: RuleContext, node: AnyNode, rawUtilities: string[]) {
  if (node.type !== "VariableDeclarator" || node.id?.type !== "Identifier") return null;
  return isH3Call(ctx, unwrapAwait(node.init), rawUtilities) ? node.id.name : null;
}

function variableReferences(ctx: RuleContext): Map<number, Set<number>> {
  const result = new Map<number, Set<number>>();
  const scope = fileTextScope(ctx);
  if (!scope) return result;
  try {
    const { scopeManager } = scope;
    for (const scope of scopeManager.scopes) {
      for (const variable of scope.variables) {
        const references = new Set(
          variable.references
            .filter(
              (reference) =>
                reference.isRead() && reference.from.variableScope === variable.scope.variableScope,
            )
            .map((reference) => reference.identifier.range[0]),
        );
        for (const definition of variable.defs) {
          if (definition.type === "Variable" && definition.node.id.type === "Identifier")
            result.set(definition.node.id.range[0], references);
        }
      }
    }
  } catch {
    return result;
  }
  return result;
}

function hasValidationOfVariable(
  scope: AnyNode,
  references: Set<number>,
  source: string,
  after: number,
) {
  let found = false;
  walkScriptLocal(scope.body ?? scope, (node) => {
    if (found || node.type !== "CallExpression") return;
    if (typeof node.start === "number" && node.start <= after) return;
    if (
      isDirectValidatorCall(node, references) ||
      isSchemaMethodValidatorCall(node, references, source)
    )
      found = true;
  });
  return found;
}

function isDirectValidatorCall(node: AnyNode, references: Set<number>) {
  const name = calleeName(node);
  return (
    Boolean(name && /^(validate|validator|parse|safeParse|assert|check)\w*$/i.test(name)) &&
    node.arguments?.some((arg: AnyNode) => arg.type === "Identifier" && references.has(arg.start))
  );
}

function isSchemaMethodValidatorCall(node: AnyNode, references: Set<number>, source: string) {
  const name = calleeName(node);
  if (name !== "parse" && name !== "safeParse" && name !== "validate") return false;
  if (
    !node.arguments?.some((arg: AnyNode) => arg.type === "Identifier" && references.has(arg.start))
  )
    return false;
  const callee = sourceForNode(node.callee, source);
  return /\b(?:schema|validator|body|query|params|input|payload|zod|valibot|v|s)\w*\.(?:parse|safeParse|validate)$/.test(
    callee,
  );
}

function methodExpressionName(
  node: AnyNode,
  source: string,
  anchor?: AnyNode,
  seen: Set<string> = new Set(),
) {
  if (node.type === "CallExpression" && calleeName(node) === "getMethod") return "getMethod";
  const text = sourceForNode(node, source);
  if (/\bevent\.(?:method|req\.method|node\.req\.method)\b/.test(text)) return text;
  if (anchor && isMemberMethodRead(node, source, anchor, seen)) return text;
  if (
    node.type === "Identifier" &&
    anchor &&
    !seen.has(node.name) &&
    isMethodAlias(anchor, node.name, source, seen)
  )
    return node.name;
  return null;
}

function staticString(node: AnyNode, source: string) {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions?.length === 0)
    return node.quasis?.[0]?.value?.cooked ?? node.quasis?.[0]?.value?.raw ?? null;
  const text = sourceForNode(node, source);
  return text.match(/^["'`]([^"'`]+)["'`]$/)?.[1] ?? null;
}

function unwrapAwait(node: AnyNode) {
  return node?.type === "AwaitExpression" ? node.argument : node;
}

function calleeName(node: AnyNode) {
  return node?.callee?.type === "Identifier"
    ? node.callee.name
    : (node?.callee?.property?.name ?? null);
}

function isMemberMethodRead(node: AnyNode, source: string, anchor: AnyNode, seen: Set<string>) {
  if (!node || (node.type !== "MemberExpression" && node.type !== "StaticMemberExpression"))
    return false;
  if (node.computed) return false;
  if (node.property?.name !== "method") return false;
  const object = node.object;
  const objectText = sourceForNode(object, source);
  if (/^event\.(?:req|node\.req)$/.test(objectText)) return true;
  if (object?.type === "Identifier" && anchor)
    return isRequestAlias(anchor, object.name, source, seen);
  return false;
}

function isRequestAlias(anchor: AnyNode, name: string, source: string, seen: Set<string>) {
  const declaration = findVariableDeclarationBefore(anchor, name);
  if (!declaration) return false;
  const init = declaration.init;
  if (!init) return false;
  const text = sourceForNode(init, source);
  if (/^event\.(?:req|node\.req)$/.test(text)) return true;
  if (init?.type === "Identifier" && !seen.has(init.name)) {
    seen.add(init.name);
    return isRequestAlias(anchor, init.name, source, seen);
  }
  return false;
}

function isMethodAlias(anchor: AnyNode, name: string, source: string, seen: Set<string>) {
  const declaration = findVariableDeclarationBefore(anchor, name);
  if (!declaration?.init) return false;
  seen.add(name);
  return Boolean(methodExpressionName(declaration.init, source, anchor, seen));
}

function findVariableDeclarationBefore(anchor: AnyNode, name: string) {
  let child = anchor;
  let scope = child.__doctorParent;
  while (scope) {
    if (scope.type === "BlockStatement" || scope.type === "Program") {
      const declaration = findDeclarationInScopeBefore(scope, child, name);
      if (declaration) return declaration;
    }
    child = scope;
    scope = scope.__doctorParent;
  }
  return null;
}

function findDeclarationInScopeBefore(scope: AnyNode, child: AnyNode, name: string) {
  let match: any = null;
  for (const statement of scope.body ?? []) {
    if (statement === child) break;
    const statementStart = statement.start ?? statement.range?.[0] ?? 0;
    const childStart = child.start ?? child.range?.[0] ?? 0;
    if (statementStart >= childStart) break;
    const declaration = variableDeclarationFromStatement(statement, name);
    if (declaration) match = declaration;
  }
  return match;
}

function variableDeclarationFromStatement(statement: AnyNode, name: string) {
  if (statement.type !== "VariableDeclaration") return null;
  return (
    statement.declarations?.find(
      (declaration: AnyNode) =>
        declaration.id?.type === "Identifier" && declaration.id.name === name,
    ) ?? null
  );
}

export function isHttpMethod(method: string) {
  return /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|CONNECT|TRACE)$/.test(method);
}
