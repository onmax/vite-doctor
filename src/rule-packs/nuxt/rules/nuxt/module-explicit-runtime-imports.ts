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
        const bindings = collectBindingNames(node);
        const firstCalls = new Map<string, AnyNode>();
        walkScriptLocal(node, (current) => {
          if (current.type !== "CallExpression" || current.callee?.type !== "Identifier") return;
          const name = current.callee.name;
          if (!MODULE_RUNTIME_AUTO_IMPORTS.has(name) || bindings.has(name)) return;
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

function collectBindingNames(program: AnyNode): Set<string> {
  const names = new Set<string>();
  const addPattern = (pattern: AnyNode) => {
    if (!pattern) return;
    switch (pattern.type) {
      case "Identifier":
        names.add(pattern.name);
        break;
      case "ObjectPattern":
        for (const property of pattern.properties ?? [])
          addPattern(property.type === "RestElement" ? property.argument : property.value);
        break;
      case "ArrayPattern":
        for (const element of pattern.elements ?? []) addPattern(element);
        break;
      case "RestElement":
        addPattern(pattern.argument);
        break;
      case "AssignmentPattern":
        addPattern(pattern.left);
        break;
      case "TSParameterProperty":
        addPattern(pattern.parameter);
        break;
    }
  };
  walkScriptLocal(program, (node) => {
    switch (node.type) {
      case "ImportSpecifier":
      case "ImportDefaultSpecifier":
      case "ImportNamespaceSpecifier":
        names.add(node.local?.name);
        break;
      case "VariableDeclarator":
        addPattern(node.id);
        break;
      case "FunctionDeclaration":
      case "TSDeclareFunction":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        if (node.id) addPattern(node.id);
        for (const parameter of node.params ?? []) addPattern(parameter);
        break;
      case "ClassDeclaration":
      case "ClassExpression":
      case "TSEnumDeclaration":
      case "TSImportEqualsDeclaration":
        if (node.id) addPattern(node.id);
        break;
      case "CatchClause":
        addPattern(node.param);
        break;
    }
  });
  return names;
}
