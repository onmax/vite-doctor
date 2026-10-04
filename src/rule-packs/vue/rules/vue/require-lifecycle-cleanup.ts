import type { SFCDescriptor } from "@vue/compiler-sfc";
import { parseForESLint } from "@typescript-eslint/parser";
import type { RuleContext } from "../../../../core/index.js";
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
  const descriptor = ctx.file.sfc?.descriptor as SFCDescriptor | undefined;
  const blocks = descriptor
    ? [descriptor.script, descriptor.scriptSetup]
        .filter((block) => block !== null)
        .map((block) => ({
          text: block.content,
          offset: block.loc.start.offset,
          jsx: block.lang === "jsx" || block.lang === "tsx",
          setup: block === descriptor.scriptSetup,
        }))
    : [
        {
          text: ctx.file.text,
          offset: 0,
          jsx: /\.[jt]sx$/.test(ctx.file.relativePath),
          setup: false,
        },
      ];
  const globalReferences = new Set<number>();
  const moduleBindings = new Set<string>();
  for (const block of blocks) {
    try {
      const { scopeManager } = parseForESLint(block.text, {
        range: true,
        sourceType: "module",
        ecmaFeatures: { jsx: block.jsx },
      });
      for (const reference of scopeManager.globalScope?.through ?? []) {
        if (block.setup && moduleBindings.has(reference.identifier.name)) continue;
        globalReferences.add(block.offset + reference.identifier.range[0]);
      }
      if (!block.setup) {
        for (const scope of scopeManager.scopes) {
          if (scope.type !== "module") continue;
          for (const variable of scope.variables) {
            if (variable.isValueVariable) moduleBindings.add(variable.name);
          }
        }
      }
    } catch {
      continue;
    }
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
