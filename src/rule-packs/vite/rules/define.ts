import { createRule, type RuleContext, type SourceRange } from "../../../core/index.js";
import { diagnostics } from "../../../diagnostics.js";
import {
  isLiteralPrimitive,
  isViteConfigFile,
  readProjectSources,
  readViteConfigFacts,
  SECRET_NAME_RE,
  hasTypeDeclaration,
} from "./shared.js";

export const noUnusedDefine = createRule({
  meta: {
    id: "vite/define/no-unused-define",
    title: "Remove unused Vite define constants",
    category: "configuration",
    severity: "info",
    execution: "workspace",
    docsUrl: "https://vite.dev/config/shared-options.html#define",
    requires: { crossFile: true },
  },
  async create(ctx) {
    return {
      async onWorkspaceEnd() {
        const configs = await readViteConfigFacts(ctx);
        const sources = await readProjectSources(ctx);
        for (const config of configs) {
          for (const entry of config.define) {
            const used = sources.some(
              (source) => source.file !== config.file && source.text.includes(entry.key),
            );
            if (used) continue;
            ctx.report(
              diagnostics.VITE0007({
                why: `Vite define constant "${entry.key}" is configured but never referenced.`,
                fix: "Remove the stale define entry or use it from source code.",
              }),
              {
                ruleId: "vite/define/no-unused-define",
                severity: ctx.severity,
                category: "configuration",
                file: config.file,
                range: entry.range,
              },
            );
          }
        }
      },
    };
  },
});

export const noUntypedDefine = createRule({
  meta: {
    id: "vite/define/no-untyped-define",
    title: "Type custom Vite define globals",
    category: "types",
    severity: "warn",
    execution: "workspace",
    docsUrl: "https://vite.dev/config/shared-options.html#define",
    requires: { crossFile: true },
  },
  async create(ctx) {
    return {
      async onWorkspaceEnd() {
        for (const config of await readViteConfigFacts(ctx)) {
          for (const entry of config.define) {
            if (entry.key.includes(".") || hasTypeDeclaration(ctx, entry.key)) continue;
            ctx.report(
              diagnostics.VITE0006({
                why: `Vite define global "${entry.key}" is not declared in a project .d.ts file.`,
                fix: `Add declare const ${entry.key}: <type> to vite-env.d.ts or env.d.ts.`,
              }),
              {
                ruleId: "vite/define/no-untyped-define",
                severity: ctx.severity,
                category: "types",
                file: config.file,
                range: entry.range,
              },
            );
          }
        }
      },
    };
  },
});

export const noRuntimeObjectDefine = createRule({
  meta: {
    id: "vite/define/no-runtime-object-define",
    title: "Avoid object values in Vite define",
    category: "configuration",
    severity: "warn",
    docsUrl: "https://vite.dev/config/shared-options.html#define",
    requires: { script: true },
  },
  create(ctx) {
    if (!isViteConfigFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node) {
        if ((node as { type?: string }).type !== "Program") return;
        for (const entry of readDefineEntriesFromCurrentFile(ctx)) {
          if (isLiteralPrimitive(entry.rawValue) || entry.rawValue.startsWith("JSON.stringify("))
            continue;
          ctx.report(
            diagnostics.VITE0004({
              why: `Vite define "${entry.key}" uses a non-primitive replacement value.`,
              fix: "Use stringified primitive define values, or import runtime configuration explicitly.",
            }),
            {
              ruleId: "vite/define/no-runtime-object-define",
              severity: ctx.severity,
              category: "configuration",
              file: ctx.file.path,
              range: entry.range,
            },
          );
        }
      },
    };
  },
});

export const noSecretDefine = createRule({
  meta: {
    id: "vite/define/no-secret-define",
    title: "Do not expose secrets through Vite define",
    category: "security",
    severity: "error",
    docsUrl: "https://vite.dev/config/shared-options.html#define",
    requires: { script: true },
  },
  create(ctx) {
    if (!isViteConfigFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node) {
        if ((node as { type?: string }).type !== "Program") return;
        for (const entry of readDefineEntriesFromCurrentFile(ctx)) {
          if (!SECRET_NAME_RE.test(entry.key) && !SECRET_NAME_RE.test(entry.rawValue)) continue;
          ctx.report(
            diagnostics.VITE0005({
              why: `Vite define "${entry.key}" looks like a secret and will be bundled into client code.`,
              fix: "Keep secrets on the server and expose only deliberate public values.",
            }),
            {
              ruleId: "vite/define/no-secret-define",
              severity: ctx.severity,
              category: "security",
              file: ctx.file.path,
              range: entry.range,
            },
          );
        }
      },
    };
  },
});

function readDefineEntriesFromCurrentFile(ctx: RuleContext) {
  const text = ctx.file.text;
  const body = /\bdefine\s*:\s*\{([\s\S]*?)\n\s*\}/m.exec(text);
  if (!body) return [];
  const base = body.index + body[0].indexOf(body[1]!);
  const entries: Array<{ key: string; rawValue: string; range: SourceRange }> = [];
  const re = /(["']?)([A-Z_$][\w$]*(?:\.[A-Z_$][\w$]*)?)\1\s*:\s*([^,\n}]+)/g;
  for (const match of body[1]!.matchAll(re)) {
    const key = match[2]!;
    const rawValue = match[3]!.trim();
    const start = base + match.index! + match[0].indexOf(key);
    entries.push({
      key,
      rawValue,
      range: ctx.helpers.rangeFromOffsets(ctx.file.path, text, start, start + key.length),
    });
  }
  return entries;
}
