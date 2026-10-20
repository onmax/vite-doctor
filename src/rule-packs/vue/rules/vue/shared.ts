import {
  codeForRuleId,
  createRule,
  diagnosticForCode,
  type DoctorRule,
  type RuleContext,
} from "../../../../core/index.js";
import { doctorInternalDiagnostics } from "../../../../core/internal-diagnostic-handles.js";
import { diagnosticCodesByRuleId, diagnostics } from "../../diagnostics.js";

export { createRule };

export type AnyNode = any;

const optionalImport = <T>(specifier: string) => import(/* @vite-ignore */ specifier) as Promise<T>;

export const BROWSER_GLOBALS = new Set([
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "navigator",
]);

export const delegatedMessages: Record<string, string> = {
  "vue/reactivity/no-ref-as-operand": "Refs used as script operands must be unwrapped with .value.",
};

export const delegatedSuggestions: Record<string, string> = {
  "vue/reactivity/no-ref-as-operand": "Use .value in script expressions.",
};

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

export { namePattern } from "../../../../core/rule-authoring.js";

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
    if (
      !foundCleanup &&
      current.type === "AwaitExpression" &&
      nearestFunctionAncestor(current) === callback
    )
      seenAwait = true;
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
  /** One or more eslint-plugin-vue rule ids whose messages all report as this Doctor Rule. */
  eslintId: string | readonly string[];
  /** Maps the Doctor Rule's options to one eslint rule's options. Defaults to passing them through. */
  eslintOptions?: (ruleOptions: unknown, eslintId: string) => unknown;
  meta: DoctorRule["meta"];
}): DoctorRule {
  const eslintIds: readonly string[] =
    typeof options.eslintId === "string" ? [options.eslintId] : options.eslintId;
  return createRule({
    meta: options.meta,
    create(ctx) {
      if (!ctx.file.isVueSfc) return;
      const rules: Record<string, EslintRuleConfig> = {};
      for (const eslintId of eslintIds)
        rules[eslintId] = eslintRuleConfig(
          options.eslintOptions ? options.eslintOptions(ctx.options, eslintId) : ctx.options,
        );
      const batch = joinEslintBatch(ctx.file, rules);
      return {
        async SFC() {
          const messages = await runEslintBatch(batch);
          for (const message of messages) {
            if (!message.ruleId || !eslintIds.includes(message.ruleId)) continue;
            reportEslintMessage(ctx, options.doctorId, options.meta, message);
          }
        },
      };
    },
  });
}

type EslintRuleConfig = "error" | ["error", ...unknown[]];
type EslintMessage = import("eslint").Linter.LintMessage;

interface EslintBatch {
  text: string;
  filename: string;
  rules: Record<string, EslintRuleConfig>;
  messages?: Promise<EslintMessage[]>;
}

// Doctor creates every pending Rule for a file before it runs any visitor, so each bridged Rule
// joins its file's batch in `create`, and the first `SFC` visitor parses and lints once for all.
const eslintBatches = new WeakMap<object, EslintBatch[]>();

function joinEslintBatch(
  file: RuleContext["file"],
  rules: Record<string, EslintRuleConfig>,
): EslintBatch {
  let batches = eslintBatches.get(file);
  if (!batches || batches.some((batch) => batch.messages || batch.text !== file.text)) {
    batches = [];
    eslintBatches.set(file, batches);
  }
  // Two Doctor Rules that bridge one eslint id with different options cannot share a config.
  const compatible = batches.find((batch) =>
    Object.keys(rules).every(
      (id) => !(id in batch.rules) || sameConfig(batch.rules[id]!, rules[id]!),
    ),
  );
  if (compatible) {
    Object.assign(compatible.rules, rules);
    return compatible;
  }
  const batch: EslintBatch = { text: file.text, filename: file.relativePath, rules: { ...rules } };
  batches.push(batch);
  return batch;
}

function sameConfig(left: EslintRuleConfig, right: EslintRuleConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function runEslintBatch(batch: EslintBatch): Promise<EslintMessage[]> {
  return (batch.messages ??= eslintVueRuntime().then(({ linter, languageOptions, plugin }) =>
    linter.verify(
      batch.text,
      [
        {
          name: "vite-doctor/eslint-plugin-vue",
          files: ["**/*.vue"],
          languageOptions,
          plugins: { vue: plugin },
          rules: batch.rules,
        },
      ],
      { filename: batch.filename },
    ),
  ));
}

let eslintVueRuntimePromise:
  | Promise<{
      linter: import("eslint").Linter;
      languageOptions: import("eslint").Linter.LanguageOptions;
      plugin: any;
    }>
  | undefined;

function eslintVueRuntime() {
  return (eslintVueRuntimePromise ??= Promise.all([
    optionalImport<typeof import("eslint")>("eslint"),
    optionalImport<typeof import("eslint-plugin-vue")>("eslint-plugin-vue"),
    optionalImport<typeof import("vue-eslint-parser")>("vue-eslint-parser"),
    optionalImport<typeof import("@typescript-eslint/parser")>("@typescript-eslint/parser"),
  ]).then(([{ Linter }, vuePlugin, vueParser, tsParser]) => {
    const tsParserRuntime = defaultExport(tsParser);
    return {
      linter: new Linter({ configType: "flat" }),
      plugin: defaultExport(vuePlugin) as any,
      languageOptions: {
        parser: defaultExport(vueParser) as any,
        ecmaVersion: "latest" as const,
        sourceType: "module" as const,
        parserOptions: {
          // Bridged Rules read <script> only; TypeScript for every template expression was most of their cost.
          parser: {
            js: tsParserRuntime,
            jsx: tsParserRuntime,
            ts: tsParserRuntime,
            tsx: tsParserRuntime,
            "<template>": "espree",
          },
          ecmaVersion: "latest",
          sourceType: "module",
        },
      },
    };
  }));
}

function reportEslintMessage(
  ctx: RuleContext,
  doctorId: string,
  meta: DoctorRule["meta"],
  message: EslintMessage,
) {
  const code = codeForRuleId(diagnosticCodesByRuleId, doctorId);
  if (!code) throw doctorInternalDiagnostics.DOC0013({ ruleId: doctorId });
  const diagnostic = diagnosticForCode(diagnostics, code);
  if (!diagnostic) throw doctorInternalDiagnostics.DOC0013({ ruleId: doctorId, code });
  ctx.report(
    diagnostic({
      why: delegatedMessages[doctorId] ?? message.message,
      fix: delegatedSuggestions[doctorId] ?? message.message,
    }),
    {
      ruleId: doctorId,
      severity: meta.severity,
      category: meta.category,
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

function defaultExport<T>(mod: T): T {
  return ((mod as { default?: T }).default ?? mod) as T;
}

function eslintRuleConfig(options: unknown): EslintRuleConfig {
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
