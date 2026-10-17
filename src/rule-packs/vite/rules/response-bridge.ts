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

function reportSetHeaderCalls(ctx: RuleContext, loop: AnyNode, body: AnyNode, key: string) {
  const calls: AnyNode[] = [];
  walk(body, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = unwrap(node.callee);
    if (callee?.type !== "MemberExpression" || memberName(callee) !== "setHeader") return;
    const name = unwrap(node.arguments[0]);
    if (name?.type === "Identifier" && name.name === key) calls.push(node);
  });
  if (calls.length === 0) return;
  const owner = enclosingFunction(loop);
  if (/set-cookie|getSetCookie/i.test(ctx.file.text.slice(owner.start, owner.end))) return;
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

function isHeadersMember(input: AnyNode): boolean {
  const node = unwrap(input);
  return node?.type === "MemberExpression" && memberName(node) === "headers";
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

function walk(node: AnyNode, visit: (node: AnyNode) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node.type !== "string") return;
  visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (key !== "__doctorParent") walk(child, visit);
  }
}
