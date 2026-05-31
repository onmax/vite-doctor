import {
  type AnyNode,
  createRule,
  nearestFunctionOrProgram,
  report,
  sourceForNode,
  walkScriptLocal,
} from "./shared.js";
import type { RuleContext } from "@vue-doctor/core";

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
      fixable: "suggestion",
      requires: { script: true, nitro: true },
    },
    create(ctx) {
      if (!ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
      return {
        ScriptNode(node: AnyNode) {
          const match = rawInputValidatedNearby(
            ctx,
            node,
            opts.rawUtilities,
            opts.validatedUtility,
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
): RawInputMatch | null {
  const variable = rawInputVariable(node, rawUtilities);
  if (!variable) return null;
  const scope = nearestFunctionOrProgram(node);
  if (
    !scope ||
    !hasValidationOfVariable(scope.body ?? scope, variable, ctx.file.text, node.start ?? 0)
  )
    return null;
  return {
    node,
    variable,
    rawUtility: rawUtilityNameFromVariableDeclarator(node),
    validatedUtility,
  };
}

export function isIpHeaderRead(node: AnyNode, source: string) {
  if (node.type !== "CallExpression") return false;
  const name = calleeName(node);
  if (name !== "getHeader" && name !== "getRequestHeader") return false;
  const header = staticString(node.arguments?.[1], source)?.toLowerCase();
  return Boolean(
    header &&
    ["x-forwarded-for", "x-real-ip", "cf-connecting-ip", "true-client-ip", "x-client-ip"].includes(
      header,
    ),
  );
}

export function isRequestSensitiveUse(ctx: RuleContext, node: AnyNode) {
  const scope = nearestFunctionOrProgram(node) ?? node;
  const text = sourceForNode(scope, ctx.file.text);
  return /\b(?:rateLimit|rateLimiter|ipLimit|throttle|ban|blockIp|allowIp|denyIp|ipAllow|ipDeny|ipBlock|ipBan|blacklist|whitelist)\b/i.test(
    text,
  );
}

export function isSingleMethodCheck(node: AnyNode, source: string) {
  if (node.type !== "BinaryExpression") return null;
  const operator = node.operator;
  if (operator !== "===" && operator !== "==" && operator !== "!==" && operator !== "!=")
    return null;
  const leftMethod = methodExpressionName(node.left, source);
  const rightMethod = methodExpressionName(node.right, source);
  const method = staticString(node.left, source) ?? staticString(node.right, source);
  if (!method || (!leftMethod && !rightMethod)) return null;
  const normalized = method.toUpperCase();
  if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(normalized)) return null;
  return normalized;
}

function rawInputVariable(node: AnyNode, rawUtilities: string[]) {
  if (node.type !== "VariableDeclarator" || node.id?.type !== "Identifier") return null;
  const call = unwrapAwait(node.init);
  if (call?.type !== "CallExpression") return null;
  const name = calleeName(call);
  return name && rawUtilities.includes(name) ? node.id.name : null;
}

function rawUtilityNameFromVariableDeclarator(node: AnyNode) {
  return calleeName(unwrapAwait(node.init)) ?? "";
}

function hasValidationOfVariable(scope: AnyNode, variable: string, source: string, after: number) {
  let found = false;
  walkScriptLocal(scope, (node) => {
    if (found || node.type !== "CallExpression") return;
    if (typeof node.start === "number" && node.start <= after) return;
    if (
      isDirectValidatorCall(node, variable) ||
      isSchemaMethodValidatorCall(node, variable, source)
    )
      found = true;
  });
  return found;
}

function isDirectValidatorCall(node: AnyNode, variable: string) {
  const name = calleeName(node);
  return (
    Boolean(name && /^(validate|validator|parse|safeParse|assert|check)\w*$/i.test(name)) &&
    node.arguments?.some((arg: AnyNode) => arg.type === "Identifier" && arg.name === variable)
  );
}

function isSchemaMethodValidatorCall(node: AnyNode, variable: string, source: string) {
  const name = calleeName(node);
  if (name !== "parse" && name !== "safeParse" && name !== "validate") return false;
  if (!node.arguments?.some((arg: AnyNode) => arg.type === "Identifier" && arg.name === variable))
    return false;
  const callee = sourceForNode(node.callee, source);
  return /\b(?:schema|validator|body|query|params|input|payload|zod|valibot|v|s)\w*\.(?:parse|safeParse|validate)$/.test(
    callee,
  );
}

function methodExpressionName(node: AnyNode, source: string) {
  if (node.type === "CallExpression" && calleeName(node) === "getMethod") return "getMethod";
  const text = sourceForNode(node, source);
  return /\bevent\.method\b|\bevent\.node\.req\.method\b/.test(text) ? text : null;
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
