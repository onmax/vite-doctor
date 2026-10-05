import type { Linter, SourceCode } from "eslint";
import {
  codeForRuleId,
  createRule,
  diagnosticForCode,
  type DoctorRule,
  type RuleCache,
  type RuleContext,
} from "../../../core/index.js";
import { doctorInternalDiagnostics } from "../../../core/internal-diagnostic-handles.js";
import { diagnosticCodesByRuleId, diagnostics } from "../diagnostics.js";

const ruleName = (id: string) => `shadcn/${id.slice("shadcn/".length)}`;

export function createShadcnRule(options: {
  id: string;
  title: string;
  description: string;
  rule: string;
  docsUrl: string;
  severity?: "error" | "warn" | "info";
}): DoctorRule {
  return createRule({
    meta: {
      id: options.id,
      title: options.title,
      description: options.description,
      category: "ui",
      severity: options.severity ?? "warn",
      fixable: "suggestion",
      docsUrl: options.docsUrl,
      requires: { script: true },
      sourceKinds: ["app", "layer"],
      execution: "file",
      cost: "medium",
      determinism: "env-dependent",
    },
    async create(ctx: RuleContext) {
      if (ctx.file.path.endsWith(".vue") || ctx.file.scriptAst?.type !== "Program") return;
      // Linting in create() instead of a ScriptNode visitor avoids a full Doctor AST walk per file.
      const messages = await lintShadcnRule(ctx, ruleName(options.id));
      for (const message of messages) {
        const code = codeForRuleId(diagnosticCodesByRuleId, options.id);
        const diagnostic = diagnosticForCode(diagnostics, code);
        if (!code || !diagnostic) throw doctorInternalDiagnostics.DOC0013({ ruleId: options.id });
        ctx.report(diagnostic({ why: message.message, fix: message.message }), {
          ruleId: options.id,
          severity: ctx.severity,
          category: "ui",
          file: ctx.file.path,
          range: lintRange(ctx.file.text, message),
          fix: message.fix
            ? {
                kind: "suggestion",
                message: "Review the suggested design-system edit before applying it.",
                edits: [
                  {
                    range: { start: message.fix.range[0], end: message.fix.range[1] },
                    text: message.fix.text,
                  },
                ],
              }
            : null,
          tags: ["shadcn", "@shadcn/lint"],
        });
      }
    },
  });
}

interface ShadcnLint {
  linter: Linter;
  parser: Linter.Parser;
  plugin: NonNullable<Linter.Config["plugins"]>[string];
}

interface ShadcnRuleConfig {
  key: string;
  name: string;
  entry: Linter.RuleEntry;
  settings: unknown;
  settingsKey: string;
}

interface FileLint {
  // undefined: not parsed yet; null: ESLint could not parse the file.
  sourceCode?: SourceCode | null;
  messages: Map<string, Linter.LintMessage[]>;
}

interface RunLint {
  rules: Map<string, ShadcnRuleConfig>;
  files: Map<string, FileLint>;
  retainedSource: number;
}

// A retained SourceCode costs roughly 250x its source length in heap, and the file Rule runner
// visits every file for one Rule before the next, so reuse is capped to keep memory bounded.
const retainedSourceBudget = 1_000_000;

let shadcnLint: Promise<ShadcnLint> | undefined;

function loadShadcnLint(): Promise<ShadcnLint> {
  shadcnLint ??= Promise.all([
    import("eslint"),
    import("@typescript-eslint/parser"),
    import("@shadcn/lint"),
  ]).then(([eslint, parser, shadcn]) => ({
    linter: new eslint.Linter({ configType: "flat" }),
    parser: (parser.default ?? parser) as Linter.Parser,
    plugin: shadcn.plugin as ShadcnLint["plugin"],
  }));
  return shadcnLint;
}

// The rule cache lives exactly as long as one Doctor Run, so it scopes the shared lint results.
const runs = new WeakMap<RuleCache, RunLint>();

async function lintShadcnRule(ctx: RuleContext, name: string): Promise<Linter.LintMessage[]> {
  const lint = await loadShadcnLint();
  let run = runs.get(ctx.cache);
  if (!run) runs.set(ctx.cache, (run = { rules: new Map(), files: new Map(), retainedSource: 0 }));
  const config = shadcnRuleConfig(name, ctx.options);
  run.rules.set(config.key, config);

  const fileKey = `${ctx.file.path}\0${ctx.file.hash}`;
  let file = run.files.get(fileKey);
  if (!file) run.files.set(fileKey, (file = { messages: new Map() }));
  const cached = file.messages.get(config.key);
  if (cached) return cached;
  if (file.sourceCode === null) return [];

  // Every shadcn Rule already seen in this run joins one verify, so a file is linted once per
  // batch of Rules instead of once per Rule. Within the budget, later batches reuse the parse.
  const batch = [config];
  const names = new Set([config.name]);
  for (const other of run.rules.values()) {
    if (other.settingsKey !== config.settingsKey || names.has(other.name)) continue;
    if (file.messages.has(other.key)) continue;
    batch.push(other);
    names.add(other.name);
  }

  let messages: Linter.LintMessage[];
  try {
    messages = verify(lint, file, ctx, batch);
  } catch (error) {
    // Another Rule's invalid options must not fail this Rule.
    if (batch.length === 1) throw error;
    batch.length = 1;
    messages = verify(lint, file, ctx, batch);
  }
  if (file.sourceCode === undefined) {
    const sourceCode = lint.linter.getSourceCode();
    if (!sourceCode) file.sourceCode = null;
    else if (run.retainedSource + ctx.file.text.length <= retainedSourceBudget) {
      file.sourceCode = sourceCode;
      run.retainedSource += ctx.file.text.length;
    }
  }
  for (const rule of batch)
    file.messages.set(
      rule.key,
      messages.filter((message) => message.ruleId === rule.name && !message.fatal),
    );
  return file.messages.get(config.key)!;
}

function verify(
  lint: ShadcnLint,
  file: FileLint,
  ctx: RuleContext,
  batch: ShadcnRuleConfig[],
): Linter.LintMessage[] {
  const messages = lint.linter.verify(
    file.sourceCode ?? ctx.file.text,
    [
      {
        name: "vite-doctor/shadcn",
        files: ["**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}"],
        languageOptions: {
          parser: lint.parser,
          ecmaVersion: "latest",
          sourceType: "module",
        },
        plugins: { shadcn: lint.plugin },
        settings: { shadcn: batch[0]!.settings },
        rules: Object.fromEntries(batch.map((rule) => [rule.name, rule.entry])),
      },
    ],
    { filename: ctx.file.relativePath },
  );
  return messages;
}

function shadcnRuleConfig(name: string, options: unknown): ShadcnRuleConfig {
  const settings = (options as any)?.settings;
  const entry: Linter.RuleEntry =
    options === undefined ? "error" : ["error", (options as any)?.options ?? options];
  const settingsKey = stableKey(settings);
  return {
    key: `${name}\0${stableKey(entry)}\0${settingsKey}`,
    name,
    entry,
    settings,
    settingsKey,
  };
}

let unserializableKeys = 0;

function stableKey(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return `unserializable:${++unserializableKeys}`;
  }
}

function lintRange(source: string, message: Linter.LintMessage) {
  let offset = 0;
  for (let line = 1; line < message.line; line++) offset = source.indexOf("\n", offset) + 1;
  const start = Math.max(0, offset + message.column - 1);
  const end = message.endLine
    ? (() => {
        let endOffset = 0;
        for (let line = 1; line < message.endLine; line++)
          endOffset = source.indexOf("\n", endOffset) + 1;
        return endOffset + message.endColumn! - 1;
      })()
    : start;
  return { start, end, line: message.line, column: message.column };
}
