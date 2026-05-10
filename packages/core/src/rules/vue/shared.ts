import { createRule, type DoctorRule, type RuleContext } from "../../primitives.js";
import { Linter } from "eslint";
import vuePlugin from "eslint-plugin-vue";
import vueParser from "vue-eslint-parser";
import tsParser from "@typescript-eslint/parser";

export { createRule };

export type AnyNode = any;

export const BROWSER_GLOBALS = new Set([
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "navigator",
]);

export const delegatedMessages: Record<string, string> = {
  "vue/reactivity/no-prop-mutation":
    "Props are read-only. Emit an update event or copy the value into local state instead.",
  "vue/reactivity/no-ref-as-operand": "Refs used as script operands must be unwrapped with .value.",
  "vue/computed/no-side-effects":
    "Computed getters must be pure. Move mutations, DOM writes, or network work into an action, watcher, or lifecycle hook.",
  "vue/computed/no-async":
    "Async computed getters do not model loading, errors, or cancellation well. Use useFetch(), useAsyncData(), or an explicit async action.",
  "vue/watch/no-after-await":
    "Watchers registered after await may not be owner-bound. Register them before the first await in setup/composables.",
  "vue/template/no-v-if-with-v-for":
    "v-if and v-for on the same element create ambiguous filtering and rendering behavior. Filter with computed state before rendering.",
};

export const delegatedSuggestions: Record<string, string> = {
  "vue/reactivity/no-prop-mutation":
    "Replace the mutation with emit('update:...') or derived local state.",
  "vue/reactivity/no-ref-as-operand": "Use .value in script expressions.",
  "vue/template/no-v-if-with-v-for": "Filter the source list before rendering.",
};

export function report(
  ctx: RuleContext,
  node: AnyNode,
  ruleId: string,
  severity: any,
  category: string,
  message: string,
  suggestion?: string,
) {
  ctx.helpers.report(ctx, node, {
    ruleId,
    severity,
    category,
    message,
    suggestion,
  });
}

export function bindingNames(pattern: AnyNode): string[] {
  if (!pattern) return [];
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "AssignmentPattern") return bindingNames(pattern.left);
  if (pattern.type === "RestElement") return bindingNames(pattern.argument);
  if (pattern.type === "ObjectPattern")
    return (pattern.properties ?? []).flatMap((property: AnyNode) =>
      bindingNames(property.value ?? property.argument ?? property.key),
    );
  if (pattern.type === "ArrayPattern")
    return (pattern.elements ?? []).flatMap((element: AnyNode) => bindingNames(element));
  return [];
}

export function isAfterAwaitInWatcherCallback(node: AnyNode): boolean {
  const callback = nearestFunctionAncestor(node);
  if (!callback || !isWatcherCallback(callback)) return false;
  let foundCleanup = false;
  let seenAwait = false;
  walkScriptLocal(callback.body ?? callback, (current) => {
    if (current === node) {
      foundCleanup = true;
      return;
    }
    if (!foundCleanup && current.type === "AwaitExpression") seenAwait = true;
  });
  return seenAwait;
}

export function isWatcherCallback(functionNode: AnyNode): boolean {
  const call = functionNode.__doctorParent;
  if (call?.type !== "CallExpression") return false;
  const name = call.callee?.name ?? call.callee?.property?.name;
  return ["watch", "watchEffect", "watchPostEffect", "watchSyncEffect"].includes(name);
}

export function nearestFunctionAncestor(node: AnyNode): AnyNode {
  let current = node?.__doctorParent;
  while (current) {
    if (
      ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
        current.type,
      )
    )
      return current;
    current = current.__doctorParent;
  }
  return null;
}

export function walkScriptLocal(node: AnyNode, visit: (node: AnyNode) => void) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkScriptLocal(child, visit);
    return;
  }
  if (typeof node.type === "string") visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "__doctorParent") continue;
    if (Array.isArray(value)) {
      for (const child of value) walkScriptLocal(child, visit);
    } else if (value && typeof value === "object") {
      walkScriptLocal(value, visit);
    }
  }
}

export function createEslintVueRule(options: {
  doctorId: string;
  eslintId: string;
  meta: DoctorRule["meta"];
}): DoctorRule {
  return createRule({
    meta: options.meta,
    create(ctx) {
      if (!ctx.file.isVueSfc) return;
      return {
        SFC() {
          const linter = new Linter({ configType: "flat" });
          const messages = linter.verify(
            ctx.file.text,
            [
              {
                name: "vue-doctor/eslint-plugin-vue",
                files: ["**/*.vue"],
                languageOptions: {
                  parser: vueParser as any,
                  ecmaVersion: "latest",
                  sourceType: "module",
                  parserOptions: {
                    parser: tsParser,
                    ecmaVersion: "latest",
                    sourceType: "module",
                  },
                },
                plugins: { vue: vuePlugin as any },
                rules: { [options.eslintId]: "error" },
              },
            ],
            { filename: ctx.file.relativePath },
          );

          for (const message of messages) {
            if (message.ruleId !== options.eslintId) continue;
            ctx.report({
              ruleId: options.doctorId,
              severity: options.meta.severity,
              category: options.meta.category,
              file: ctx.file.path,
              range: rangeFromLintMessage(ctx.file.text, message),
              message: delegatedMessages[options.doctorId] ?? message.message,
              suggestion: delegatedSuggestions[options.doctorId] ?? message.message,
              fix: message.fix
                ? {
                    kind: "suggestion",
                    message:
                      "eslint-plugin-vue can suggest a fix, but Vue Doctor does not classify it as safe.",
                    edits: [
                      {
                        range: { start: message.fix.range[0], end: message.fix.range[1] },
                        text: message.fix.text,
                      },
                    ],
                  }
                : null,
              tags: ["eslint-plugin-vue"],
            });
          }
        },
      };
    },
  });
}

export function rangeFromLintMessage(source: string, message: AnyNode) {
  const start = offsetFromLineColumn(source, message.line, message.column);
  const end =
    message.endLine && message.endColumn
      ? offsetFromLineColumn(source, message.endLine, message.endColumn)
      : start;
  return { start, end, line: message.line, column: message.column };
}

export function offsetFromLineColumn(source: string, line: number, column: number) {
  let offset = 0;
  let currentLine = 1;
  while (currentLine < line && offset < source.length) {
    const next = source.indexOf("\n", offset);
    if (next === -1) return source.length;
    offset = next + 1;
    currentLine++;
  }
  return Math.min(source.length, offset + column - 1);
}
