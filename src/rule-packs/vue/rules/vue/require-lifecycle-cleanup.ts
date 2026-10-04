import { parseForESLint } from "@typescript-eslint/parser";
import type { RuleContext } from "../../../../core/index.js";
import { createVueScriptForParsing } from "../../../../core/internal/sfc.js";
import { AnyNode, createRule, report, walkScriptLocal } from "./shared.js";

const RESOURCE_CALLS = new Set(["setInterval", "addEventListener"]);
const RESOURCE_CONSTRUCTORS = new Set(["ResizeObserver", "IntersectionObserver", "WebSocket"]);
const GLOBAL_RECEIVERS = new Set(["window", "document", "globalThis", "self"]);

export const requireLifecycleCleanup = createRule({
  meta: {
    id: "vue/lifecycle/require-cleanup",
    title: "Clean up lifecycle resources",
    category: "lifecycle",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    if (ctx.project.framework === "nuxt" && !isNuxtVueRuntimePath(ctx.file.relativePath)) return;
    let hasCleanup = false;
    return {
      ScriptNode(node: AnyNode) {
        if (
          ctx.helpers.isCall(node, "onUnmounted") ||
          ctx.helpers.isCall(node, "onBeforeUnmount") ||
          ctx.helpers.isCall(node, "onScopeDispose")
        )
          hasCleanup = true;
        if (node.type !== "Program") return;
        if (!createsBrowserResource(ctx, node)) return;
        if (
          /(clearInterval|removeEventListener|disconnect|close)\s*\(/.test(ctx.file.text) ||
          hasCleanup ||
          returnsLongLivedResource(ctx.file.text)
        )
          return;
        report(
          ctx,
          node,
          "vue/lifecycle/require-cleanup",
          "warn",
          "lifecycle",
          "This component creates a long-lived browser resource without lifecycle cleanup.",
          "Register cleanup with onUnmounted() or onScopeDispose().",
        );
      },
    };
  },
});

function createsBrowserResource(ctx: RuleContext, program: AnyNode): boolean {
  const candidates: number[] = [];
  walkScriptLocal(program, (node) => {
    const names =
      node.type === "CallExpression"
        ? RESOURCE_CALLS
        : node.type === "NewExpression"
          ? RESOURCE_CONSTRUCTORS
          : undefined;
    if (!names) return;
    const callee = node.callee;
    if (callee?.type === "Identifier" && names.has(callee.name)) {
      candidates.push(callee.start);
    } else if (callee?.type === "MemberExpression") {
      const member = staticMemberName(callee);
      if (!member || !names.has(member)) return;
      const receiver = callee.object;
      if (receiver?.type === "Identifier" && GLOBAL_RECEIVERS.has(receiver.name))
        candidates.push(receiver.start);
    }
  });
  if (!candidates.length) return false;
  const parsedVueScript = ctx.file.sfc
    ? createVueScriptForParsing(ctx.file.sfc.descriptor, ctx.file.text)
    : undefined;
  const source = parsedVueScript?.text ?? ctx.file.text;
  let globalReferences: Set<number>;
  try {
    const { scopeManager } = parseForESLint(source, {
      range: true,
      sourceType: "module",
      ecmaFeatures: {
        jsx:
          parsedVueScript?.lang === "jsx" ||
          parsedVueScript?.lang === "tsx" ||
          /\.[jt]sx$/.test(ctx.file.relativePath),
      },
    });
    globalReferences = new Set(
      scopeManager.globalScope?.through.map((reference) => reference.identifier.range[0]),
    );
  } catch {
    return false;
  }
  return candidates.some((position) => globalReferences.has(position));
}

function staticMemberName(node: AnyNode): string | null {
  if (!node.computed && node.property?.type === "Identifier") return node.property.name;
  if (node.property?.type === "Literal" && typeof node.property.value === "string")
    return node.property.value;
  return null;
}

function returnsLongLivedResource(source: string) {
  const resource =
    /\bconst\s+(\w+)\s*=\s*new\s+(?:ResizeObserver|IntersectionObserver|WebSocket)\b/.exec(source);
  return Boolean(resource?.[1] && new RegExp(`\\breturn\\s+${resource[1]}\\b`).test(source));
}

function isNuxtVueRuntimePath(path: string) {
  if (
    path.includes(".client.") ||
    /\.(md|mdc|markdown)$/.test(path) ||
    /^(content|server|app\/server|shared\/types|generated|app\/generated)\//.test(path)
  )
    return false;
  return /^(app\/)?(components|composables|layouts|middleware|pages|plugins|utils)\//.test(path);
}
