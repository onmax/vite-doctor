import {
  codeForRuleId,
  createRule,
  diagnosticForCode,
  type DoctorRule,
  type RuleContext,
} from "../../../../core/index.js";
import { doctorInternalDiagnostics } from "../../../../core/internal-diagnostic-handles.js";
import { isAstNode } from "../../../../core/internal/ast-node.js";
import { isRecord } from "../../../../core/internal/value-schema.js";
import { diagnosticCodesByRuleId, diagnostics } from "../../diagnostics.js";

export { createRule };

export type AnyNode = any;

export const BROWSER_GLOBALS = new Set([
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "navigator",
]);

export const delegatedMessages = new Map([
  [
    "vue/reactivity/no-ref-as-operand",
    "Refs used as script operands must be unwrapped with .value.",
  ],
]);

export const delegatedSuggestions = new Map([
  ["vue/reactivity/no-ref-as-operand", "Use .value in script expressions."],
]);

export function report(
  ctx: RuleContext,
  node: AnyNode,
  ruleId: string,
  severity: any,
  category: string,
  message: string,
  suggestion: string,
) {
  const code = codeForRuleId(diagnosticCodesByRuleId, ruleId);
  if (!code) throw doctorInternalDiagnostics.DOC0013({ ruleId });
  const diagnostic = diagnosticForCode(diagnostics, code);
  if (!diagnostic) throw doctorInternalDiagnostics.DOC0013({ ruleId, code });
  ctx.helpers.report(ctx, node, diagnostic({ why: message, fix: suggestion }), {
    ruleId,
    severity,
    category,
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
  if (Array.isArray(node)) {
    for (const child of node) walkScriptLocal(child, visit);
    return;
  }
  if (!(node instanceof Object)) return;
  if (isAstNode(node)) visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "__doctorParent") continue;
    if (Array.isArray(value)) {
      for (const child of value) walkScriptLocal(child, visit);
    } else if (value instanceof Object) {
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
        async SFC() {
          const [{ Linter }, vuePlugin, vueParser, tsParser] = await Promise.all([
            import("eslint"),
            import("eslint-plugin-vue"),
            import("vue-eslint-parser"),
            import("@typescript-eslint/parser"),
          ]);
          const vuePluginRuntime = vuePlugin.default ?? vuePlugin;
          const vueParserRuntime = vueParser.default ?? vueParser;
          const tsParserRuntime = tsParser.default ?? tsParser;
          const linter = new Linter({ configType: "flat" });
          const messages = linter.verify(
            ctx.file.text,
            [
              {
                name: "vite-doctor/eslint-plugin-vue",
                files: ["**/*.vue"],
                languageOptions: {
                  parser: vueParserRuntime,
                  ecmaVersion: "latest",
                  sourceType: "module",
                  parserOptions: {
                    parser: tsParserRuntime,
                    ecmaVersion: "latest",
                    sourceType: "module",
                  },
                },
                plugins: { vue: vuePluginRuntime },
                rules: { [options.eslintId]: eslintRuleConfig(ctx.options) },
              },
            ],
            { filename: ctx.file.relativePath },
          );

          for (const message of messages) {
            if (message.ruleId !== options.eslintId) continue;
            const code = codeForRuleId(diagnosticCodesByRuleId, options.doctorId);
            if (!code) throw doctorInternalDiagnostics.DOC0013({ ruleId: options.doctorId });
            const diagnostic = diagnosticForCode(diagnostics, code);
            if (!diagnostic)
              throw doctorInternalDiagnostics.DOC0013({ ruleId: options.doctorId, code });
            ctx.report(
              diagnostic({
                why: delegatedMessages.get(options.doctorId) ?? message.message,
                fix: delegatedSuggestions.get(options.doctorId) ?? message.message,
              }),
              {
                ruleId: options.doctorId,
                severity: options.meta.severity,
                category: options.meta.category,
                file: ctx.file.path,
                range: rangeFromLintMessage(ctx.file.text, message),
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
              },
            );
          }
        },
      };
    },
  });
}

function eslintRuleConfig(options: unknown): "error" | ["error", ...unknown[]] {
  if (Array.isArray(options)) return ["error", ...options];
  return options ? ["error", options] : "error";
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
export function booleanRuleOption(options: unknown, key: string): boolean {
  return isRecord(options) && options[key] === true;
}
