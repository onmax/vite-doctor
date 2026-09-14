import { Linter } from "eslint";
import parser from "@typescript-eslint/parser";
import { plugin } from "@shadcn/lint";
import {
  codeForRuleId,
  createRule,
  diagnosticForCode,
  type DoctorRule,
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
    create(ctx: RuleContext) {
      if (ctx.file.path.endsWith(".vue")) return;
      return {
        ScriptNode(node: any) {
          if (node.type !== "Program") return;
          const linter = new Linter({ configType: "flat" });
          const messages = linter.verify(
            ctx.file.text,
            [
              {
                name: "vite-doctor/shadcn",
                files: ["**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}"],
                languageOptions: {
                  parser,
                  ecmaVersion: "latest",
                  sourceType: "module",
                },
                plugins: { shadcn: plugin },
                settings: { shadcn: (ctx.options as any)?.settings },
                rules: {
                  [ruleName(options.id)]:
                    ctx.options === undefined
                      ? "error"
                      : ["error", (ctx.options as any)?.options ?? ctx.options],
                },
              },
            ],
            { filename: ctx.file.relativePath },
          );
          for (const message of messages) {
            if (message.ruleId !== ruleName(options.id) || message.fatal) continue;
            const code = codeForRuleId(diagnosticCodesByRuleId, options.id);
            const diagnostic = diagnosticForCode(diagnostics, code);
            if (!code || !diagnostic)
              throw doctorInternalDiagnostics.DOC0013({ ruleId: options.id });
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
      };
    },
  });
}

function lintRange(source: string, message: any) {
  let offset = 0;
  for (let line = 1; line < message.line; line++) offset = source.indexOf("\n", offset) + 1;
  const start = Math.max(0, offset + message.column - 1);
  const end = message.endLine
    ? (() => {
        let endOffset = 0;
        for (let line = 1; line < message.endLine; line++)
          endOffset = source.indexOf("\n", endOffset) + 1;
        return endOffset + message.endColumn - 1;
      })()
    : start;
  return { start, end, line: message.line, column: message.column };
}
