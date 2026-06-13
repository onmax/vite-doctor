import {
  type AnyNode,
  createRule,
  nearestFunctionOrProgram,
  report,
  sourceForNode,
  walkScriptLocal,
} from "./shared.js";
import type { RuleContext } from "../../../core/index.js";

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
      fixable: "suggestion",
      docsUrl: opts.docsUrl,
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

export function isInIfStatementTest(node: AnyNode) {
  let current = node;
  while (current) {
    const parent = current.__doctorParent;
    if (!parent) return false;
    if (parent.type === "IfStatement" && parent.test === current) return true;
    current = parent;
  }
  return false;
}

export function isNitroRouteFile(relativePath: string) {
  const path = normalizePath(relativePath);
  return /^(?:(?:app\/)?server\/)?(?:api|routes)\/.+\.[cm]?[jt]s$/.test(path);
}

export function routeMethodSuffix(relativePath: string) {
  const path = normalizePath(relativePath);
  const match = path.match(/\.([a-z]+)(?:\.(?:dev|prod|prerender))?\.[cm]?[jt]s$/);
  const method = match?.[1]?.toUpperCase();
  return method && isHttpMethod(method) ? method : null;
}

export function routePathWithMethodSuffix(relativePath: string, suffix: string) {
  const path = normalizePath(relativePath);
  const existingMethod = routeMethodSuffix(path);
  if (existingMethod) {
    return path.replace(
      new RegExp(
        `\\.${existingMethod.toLowerCase()}(\\.(?:dev|prod|prerender))?(\\.[cm]?[jt]s)$`,
        "i",
      ),
      `.${suffix}$1$2`,
    );
  }
  return path.replace(
    /(\.(?:dev|prod|prerender))?(\.[cm]?[jt]s)$/,
    (_match, env = "", extension) => `.${suffix}${env}${extension}`,
  );
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

function isHttpMethod(method: string) {
  return /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|CONNECT|TRACE)$/.test(method);
}

function normalizePath(path: string) {
  return path.replace(/\\/g, "/");
}
