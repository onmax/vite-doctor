import { parseForESLint } from "@typescript-eslint/parser";
import { createVueScriptForParsing } from "../../../../core/internal/sfc.js";
import type { FixEdit } from "../../../../core/index.js";
import { AnyNode, createRule, walkScriptLocal } from "./shared.js";
import { packageModuleRuntime } from "./module-authoring.js";
import { MODULE_RUNTIME_AUTO_IMPORTS } from "./module-runtime-auto-imports.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "nuxt/module/explicit-runtime-imports";

export const moduleExplicitRuntimeImports = createRule({
  meta: {
    id: RULE_ID,
    title: "Import Nuxt helpers explicitly in module runtime files",
    category: "modules",
    severity: "error",
    fixable: "safe",
    docsUrl: "https://nuxt.com/docs/4.x/guide/modules/module-anatomy#add-runtime-code",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!packageModuleRuntime(ctx)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Program") return;
        const script = ctx.file.sfc
          ? createVueScriptForParsing(ctx.file.sfc.descriptor, ctx.file.text)
          : { text: ctx.file.text, lang: /\.[jt]sx$/.test(ctx.file.relativePath) ? "tsx" : "ts" };
        const unbound = unboundReferences(script.text, ctx.file.path, script.lang);
        if (!unbound) return;
        const firstCalls = new Map<string, AnyNode>();
        walkScriptLocal(node, (current) => {
          if (current.type !== "CallExpression" || current.callee?.type !== "Identifier") return;
          const name = current.callee.name;
          if (!MODULE_RUNTIME_AUTO_IMPORTS.has(name) || !unbound.has(current.callee.start)) return;
          const previous = firstCalls.get(name);
          if (!previous || current.start < previous.start) firstCalls.set(name, current);
        });
        if (!firstCalls.size) return;
        const names = [...firstCalls.keys()].sort();
        const edit = importInsertion(node, ctx.file.text, names);
        const importStatement = `import { ${names.join(", ")} } from '#imports'`;
        for (const [name, call] of [...firstCalls].sort((a, b) => a[1].start - b[1].start)) {
          ctx.report(
            diagnostics.NUXT0083({
              why: `${name}() relies on an auto-import, but Nuxt and Nitro skip auto-import transforms for files inside node_modules, where this module's runtime code lives once published. The call fails with a ReferenceError in projects that install the module.`,
              fix: `Import the runtime helpers explicitly: ${importStatement}.`,
            }),
            {
              ruleId: RULE_ID,
              severity: ctx.severity,
              category: "modules",
              file: ctx.file.path,
              range: ctx.range(call.callee),
              fix: edit ? { kind: "safe", edits: [edit] } : null,
            },
          );
        }
      },
    };
  },
});

function importInsertion(program: AnyNode, text: string, names: string[]): FixEdit | null {
  const body: AnyNode[] = program.body ?? [];
  const imports = body.filter((statement) => statement.type === "ImportDeclaration");
  const quote = imports.some((item) => text[item.source?.start] === '"') ? '"' : "'";
  const semicolon = imports.length
    ? imports.some((item) => text[item.end - 1] === ";")
    : body.some((statement) => text[statement.end - 1] === ";");
  const statement = `import { ${names.join(", ")} } from ${quote}#imports${quote}${semicolon ? ";" : ""}`;
  const last = imports.at(-1);
  if (last) return { range: { start: last.end, end: last.end }, text: `\n${statement}` };
  const first = body[0];
  if (!first) return null;
  return { range: { start: first.start, end: first.start }, text: `${statement}\n` };
}

function unboundReferences(source: string, file: string, lang: string): Set<number> | undefined {
  try {
    const { scopeManager } = parseForESLint(source, {
      sourceType: "module",
      range: true,
      ecmaFeatures: { jsx: lang === "jsx" || lang === "tsx" },
      filePath: file.endsWith(".vue") ? `${file}.${lang}` : file,
    });
    return new Set(
      scopeManager.globalScope?.through
        .filter((reference) => reference.isValueReference)
        .map((reference) => reference.identifier.range[0]),
    );
  } catch {
    return undefined;
  }
}
