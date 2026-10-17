import { createRule, type RuleContext } from "../../../core/index.js";
import { diagnostics } from "../../../diagnostics.js";
import { propertyName, staticString, type AnyNode } from "./shared.js";

export const noLossySetCookieBridge = createRule({
  meta: {
    id: "vite/plugin/no-lossy-set-cookie-bridge",
    title: "Keep every Set-Cookie when copying Fetch response headers",
    category: "plugins",
    severity: "warn",
    docsUrl: "https://developer.mozilla.org/docs/Web/API/Headers/getSetCookie",
    requires: { script: true },
    prefilter: { names: ["setHeader"] },
  },
  create(ctx) {
    return {
      ForOfStatement(node: AnyNode) {
        if (!isHeadersIterable(node.right)) return;
        const key = forOfKeyName(node.left);
        if (key) reportSetHeaderCalls(ctx, node, node.body, key);
      },
      CallExpression(node: AnyNode) {
        const callee = unwrap(node.callee);
        if (callee?.type !== "MemberExpression" || memberName(callee) !== "forEach") return;
        if (!isHeadersMember(callee.object)) return;
        const callback = unwrap(node.arguments[0]);
        if (!isFunction(callback)) return;
        const key = callback.params[1];
        if (key?.type === "Identifier") reportSetHeaderCalls(ctx, node, callback.body, key.name);
      },
    };
  },
});

const SET_COOKIE = /set-cookie|getSetCookie/i;

function reportSetHeaderCalls(ctx: RuleContext, loop: AnyNode, body: AnyNode, key: string) {
  const calls: AnyNode[] = [];
  let filtersKey = false;
  walkBinding(body, key, (node) => {
    if (node.type === "Identifier" && node.name === key && !isSetHeaderName(node))
      filtersKey = true;
    if (node.type === "CallExpression" && isSetHeaderName(unwrap(node.arguments[0]), key))
      calls.push(node);
  });
  if (calls.length === 0) return;
  const text = ctx.file.text;
  // Set-Cookie survives when the loop body skips it, or when the function writes it after the loop.
  if (SET_COOKIE.test(text.slice(body.start, body.end))) return;
  if (filtersKey && SET_COOKIE.test(text)) return;
  if (SET_COOKIE.test(text.slice(loop.end, enclosingFunction(loop).end))) return;
  for (const call of calls) {
    ctx.report(
      diagnostics.VITE0025({
        why: "Iterating Fetch Headers yields each Set-Cookie value as its own entry, and Node's setHeader replaces the previous value, so only the last cookie reaches the client.",
        fix: 'Copy Set-Cookie with res.setHeader("set-cookie", response.headers.getSetCookie()) or appendHeader, and skip "set-cookie" in this loop.',
      }),
      { file: ctx.file.path, range: ctx.range(call) },
    );
  }
}

// The header name passed as the first argument of `target.setHeader(name, value)`.
function isSetHeaderName(node: AnyNode, key?: string): boolean {
  if (node?.type !== "Identifier" || (key !== undefined && node.name !== key)) return false;
  const call = node.__doctorParent;
  if (call?.type !== "CallExpression" || unwrap(call.arguments[0]) !== node) return false;
  const callee = unwrap(call.callee);
  return callee?.type === "MemberExpression" && memberName(callee) === "setHeader";
}

function isHeadersIterable(input: AnyNode): boolean {
  const node = unwrap(input);
  if (isHeadersMember(node)) return true;
  if (node?.type !== "CallExpression" || node.arguments.length > 0) return false;
  const callee = unwrap(node.callee);
  return (
    callee?.type === "MemberExpression" &&
    memberName(callee) === "entries" &&
    isHeadersMember(callee.object)
  );
}

// Request headers carry Cookie, never Set-Cookie, so copying them loses nothing.
function isHeadersMember(input: AnyNode): boolean {
  const node = unwrap(input);
  if (node?.type !== "MemberExpression" || memberName(node) !== "headers") return false;
  const owner = unwrap(node.object);
  const name = owner?.type === "MemberExpression" ? memberName(owner) : owner?.name;
  return !(typeof name === "string" && /(?:^|[a-z_])req(?:uest)?$/i.test(name));
}

function forOfKeyName(left: AnyNode): string | null {
  const pattern = left?.type === "VariableDeclaration" ? left.declarations[0]?.id : left;
  const key = pattern?.type === "ArrayPattern" ? pattern.elements[0] : undefined;
  return key?.type === "Identifier" ? key.name : null;
}

function memberName(node: AnyNode): string | null {
  return node.computed ? staticString(node.property) : propertyName(node.property);
}

function enclosingFunction(node: AnyNode): AnyNode {
  let current = node.__doctorParent;
  while (current) {
    if (isFunction(current)) return current;
    if (!current.__doctorParent) return current;
    current = current.__doctorParent;
  }
  return node;
}

function isFunction(node: AnyNode): boolean {
  return ["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(
    node?.type,
  );
}

function unwrap(node: AnyNode): AnyNode {
  while (
    node &&
    [
      "TSAsExpression",
      "TSTypeAssertion",
      "TSSatisfiesExpression",
      "TSNonNullExpression",
      "ParenthesizedExpression",
      "ChainExpression",
    ].includes(node.type)
  )
    node = node.expression;
  return node;
}

// Walks `node` without entering nested functions that rebind `name`.
function walkBinding(node: AnyNode, name: string, visit: (node: AnyNode) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkBinding(child, name, visit);
    return;
  }
  if (typeof node.type !== "string") return;
  if (isFunction(node) && node.params.some((param: AnyNode) => bindsName(param, name))) return;
  visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (key !== "__doctorParent") walkBinding(child, name, visit);
  }
}

function bindsName(pattern: AnyNode, name: string): boolean {
  if (pattern?.type === "Identifier") return pattern.name === name;
  if (pattern?.type === "AssignmentPattern") return bindsName(pattern.left, name);
  if (pattern?.type === "RestElement") return bindsName(pattern.argument, name);
  if (pattern?.type === "ArrayPattern")
    return pattern.elements.some((item: AnyNode) => bindsName(item, name));
  if (pattern?.type === "ObjectPattern")
    return pattern.properties.some((item: AnyNode) => bindsName(item.value ?? item.argument, name));
  return false;
}
