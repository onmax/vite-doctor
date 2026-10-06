import { createRule } from "../../../core/index.js";
import { globalReferenceStarts, isLikelySsrFile, staticString, type AnyNode } from "./shared.js";
import { diagnostics } from "../../../diagnostics.js";

export const noBrowserGlobalInSsrEntry = createRule({
  meta: {
    id: "vite/ssr/no-browser-global-in-ssr-entry",
    title: "Avoid browser globals in Vite SSR entries",
    category: "ssr",
    severity: "error",
    docsUrl: "https://vite.dev/guide/ssr.html#conditional-logic",
    requires: { script: true },
  },
  create(ctx) {
    if (!isLikelySsrFile(ctx.file.relativePath)) return;
    let globalReferences: Set<number> | null | undefined;
    return {
      Identifier(node: AnyNode) {
        if (!globalNames.has(node.name)) return;
        const name = node.name === "globalThis" ? staticMemberName(node.__doctorParent) : node.name;
        if (!name || !browserGlobals.has(name)) return;
        if (globalReferences === undefined)
          globalReferences = globalReferenceStarts(ctx, globalNames);
        if (
          globalReferences?.has(node.start) === false ||
          ctx.helpers.isTypeOnlyContext(node) ||
          ctx.helpers.isTypeofOperand(node) ||
          (node.name === "globalThis" && ctx.helpers.isTypeofOperand(node.__doctorParent)) ||
          isExcludedFromSsr(node)
        )
          return;
        ctx.report(
          diagnostics.VITE0018({
            why: `Vite SSR entry "${ctx.file.relativePath}" reads browser global "${name}".`,
            fix: "Guard browser-only code behind client execution or move it to the client entry.",
          }),
          {
            ruleId: "vite/ssr/no-browser-global-in-ssr-entry",
            severity: ctx.severity,
            category: "ssr",
            file: ctx.file.path,
            range: ctx.range(node),
          },
        );
      },
    };
  },
});

const browserGlobals = new Set([
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "navigator",
]);

const globalNames = new Set([...browserGlobals, "globalThis"]);

function staticMemberName(node: AnyNode): string | null {
  if (node?.type !== "MemberExpression") return null;
  return node.computed ? staticString(node.property) : (node.property?.name ?? null);
}

function isExcludedFromSsr(node: AnyNode): boolean {
  let child = node;
  for (let parent = child.__doctorParent; parent; parent = child.__doctorParent) {
    if (parent.type === "IfStatement" || parent.type === "ConditionalExpression") {
      const condition = ssrBoolean(parent.test);
      if (child === parent.consequent && condition === false) return true;
      if (child === parent.alternate && condition === true) return true;
    }
    if (parent.type === "LogicalExpression" && child === parent.right) {
      const condition = ssrBoolean(parent.left);
      if (parent.operator === "&&" && condition === false) return true;
      if (parent.operator === "||" && condition === true) return true;
    }
    child = parent;
  }
  return false;
}

function ssrBoolean(node: AnyNode): boolean | undefined {
  if (!node) return undefined;
  if (node.type === "Literal" && typeof node.value === "boolean") return node.value;
  if (["TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression"].includes(node.type))
    return ssrBoolean(node.expression);
  if (node.type === "MemberExpression" && staticMemberName(node) === "SSR") {
    const env = node.object;
    const meta = env?.object;
    if (
      staticMemberName(env) === "env" &&
      meta?.type === "MetaProperty" &&
      meta.meta?.name === "import" &&
      meta.property?.name === "meta"
    )
      return true;
  }
  if (node.type === "UnaryExpression" && node.operator === "!") {
    const value = ssrBoolean(node.argument);
    return value === undefined ? undefined : !value;
  }
  if (node.type === "LogicalExpression") {
    const left = ssrBoolean(node.left);
    const right = ssrBoolean(node.right);
    if (node.operator === "&&") {
      if (left === false || right === false) return false;
      if (left === true && right === true) return true;
    }
    if (node.operator === "||") {
      if (left === true || right === true) return true;
      if (left === false && right === false) return false;
    }
  }
  if (node.type === "BinaryExpression" && ["===", "!==", "==", "!="].includes(node.operator)) {
    const left = ssrBoolean(node.left);
    const right = ssrBoolean(node.right);
    if (left !== undefined && right !== undefined)
      return ["===", "=="].includes(node.operator) ? left === right : left !== right;
  }
  return undefined;
}
