import type { SFCDescriptor } from "@vue/compiler-sfc";
import type { AST } from "vue-eslint-parser";
import type { RuleContext } from "../../../../core/index.js";
import { fileScriptScope, type ScopeVariable } from "../../../../core/internal/script-scope.js";
import { diagnostics } from "../../diagnostics.js";
import { AnyNode, createRule, isRuntimeAppFile } from "./shared.js";
import { scriptNodesOfType } from "./script-index.js";

const RULE_ID = "nuxt/routing/navigate-to-external";
// ufo's hasProtocol(toPath, { acceptRelative: true }), which navigateTo uses to spot external URLs.
const PROTOCOL = /^[\s\w\0+.-]{2,}:([/\\]{2})?/;
const PROTOCOL_RELATIVE = /^([/\\]\s*){2,}[^/\\]/;
// With `external: true` these still throw (NUXT_E2002), so adding the option would not help.
const SCRIPT_PROTOCOL = /^[\s\0]*(?:blob|data|javascript|vbscript):/i;
const NUXT_SOURCES = new Set(["#app", "nuxt/app", "#app/composables/router"]);
const NUXT_AUTO_IMPORT_SOURCE = /^(?:#app|nuxt\/app|nuxt)(?:\/|$)|(?:^|\/)nuxt\/dist\/app\//;

export const navigateToExternal = createRule({
  meta: {
    id: RULE_ID,
    title: "Pass external: true to navigateTo for external URLs",
    category: "routing",
    severity: "error",
    confidence: "heuristic-high",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/api/utils/navigate-to#external-url",
    requires: { nuxt: true },
    prefilter: { names: ["navigateTo"] },
  },
  create(ctx) {
    if (!isRuntimeAppFile(ctx)) return;
    const scope = fileScriptScope(ctx);
    if (!scope) return;
    const check = (call: AnyNode, offset = 0) => {
      const url = externalUrl(call);
      if (url) {
        const [start, end] = call.range ?? [call.start, call.end];
        report(ctx, { start: start + offset, end: end + offset }, url);
      }
    };
    return {
      Program() {
        for (const call of scriptNodesOfType(scope.ast, "CallExpression")) {
          if (call.callee?.type !== "Identifier") continue;
          const reference = scope.references.get(call.callee);
          if (reference && isNuxtBinding(ctx, call.callee.name, reference.resolved)) check(call);
        }
      },
      async SFC(sfc) {
        const { script, template } = sfc.descriptor as SFCDescriptor;
        if (script || !template || template.src || (template.lang && template.lang !== "html"))
          return;
        const bindings = scope.scopeManager.scopes.find((item) => item.type === "module")?.set;
        const [{ parseForESLint }, tsParser] = await Promise.all([
          import("vue-eslint-parser"),
          import("@typescript-eslint/parser"),
        ]);
        const prefix = "<template>";
        const offset = template.loc.start.offset - prefix.length;
        let root;
        try {
          root = parseForESLint(`${prefix}${template.content}</template>`, {
            filePath: ctx.file.path,
            parser: { "<template>": tsParser },
            sourceType: "module",
            ecmaVersion: "latest",
          }).ast.templateBody;
        } catch {
          return;
        }
        if (!root) return;
        visitTemplate(root, (node) => {
          for (const { id, variable } of node.references) {
            const call = id.parent;
            if (
              !variable &&
              call?.type === "CallExpression" &&
              call.callee === id &&
              isNuxtBinding(ctx, id.name, bindings?.get(id.name))
            )
              check(call, offset);
          }
        });
      },
    };
  },
});

function visitTemplate(
  node: AST.VElement | AST.VText | AST.VExpressionContainer,
  visit: (expression: AST.VExpressionContainer) => void,
) {
  if (node.type === "VExpressionContainer") visit(node);
  if (node.type !== "VElement") return;
  for (const attribute of node.startTag.attributes) {
    if (!attribute.directive) continue;
    if (attribute.key.argument?.type === "VExpressionContainer") visit(attribute.key.argument);
    if (attribute.value) visit(attribute.value);
  }
  for (const child of node.children) visitTemplate(child, visit);
}

function isNuxtBinding(ctx: RuleContext, name: string, binding: ScopeVariable | null | undefined) {
  if (!binding?.isValueVariable)
    return !!ctx.project.nuxt?.autoImportEnabled && isNuxtAutoImport(ctx, name, false);
  return binding.defs.some((definition) => {
    if (definition.type !== "ImportBinding") return false;
    const { node, parent } = definition;
    if (
      node.type !== "ImportSpecifier" ||
      node.importKind === "type" ||
      parent.type !== "ImportDeclaration" ||
      parent.importKind === "type"
    )
      return false;
    const imported = node.imported.type === "Identifier" ? node.imported.name : node.imported.value;
    return parent.source.value === "#imports"
      ? isNuxtAutoImport(ctx, imported, true)
      : imported === "navigateTo" && NUXT_SOURCES.has(parent.source.value);
  });
}

function isNuxtAutoImport(ctx: RuleContext, name: string, explicit: boolean): boolean {
  const nuxt = ctx.project.nuxt;
  if (!nuxt || (explicit && !nuxt.autoImportsAuthoritative)) return false;
  const entry = nuxt.autoImports.get(name);
  if (!entry) return name === "navigateTo" && !nuxt.autoImportsAuthoritative;
  return (
    entry.name === "navigateTo" &&
    !entry.type &&
    (NUXT_AUTO_IMPORT_SOURCE.test(entry.from) ||
      (!explicit && entry.from === "#imports" && entry.kind === "nuxt"))
  );
}

/** The URL prefix the call navigates to when it is an external URL without `external: true`. */
function externalUrl(call: AnyNode): { prefix: string; complete: boolean } | undefined {
  const [target, options] = call.arguments ?? [];
  if (!target || target.type === "SpreadElement") return undefined;
  const url = literalPrefix(target);
  if (!url || SCRIPT_PROTOCOL.test(url.prefix)) return undefined;
  if (!PROTOCOL.test(url.prefix) && !PROTOCOL_RELATIVE.test(url.prefix)) return undefined;
  if (options && !lacksExternal(options)) return undefined;
  return url;
}

/**
 * Whether the options object provably leaves `external` unset or false. `open` takes another
 * path on the client, and spreads or computed values may set `external`.
 */
function lacksExternal(options: AnyNode): boolean {
  if (options.type !== "ObjectExpression") return false;
  for (const property of options.properties ?? []) {
    if (property.type !== "Property" || property.computed) return false;
    const key = property.key?.name ?? property.key?.value;
    if (key === "open") return false;
    if (key !== "external") continue;
    if (property.value?.type !== "Literal" || property.value.value !== false) return false;
  }
  return true;
}

/** The leading literal text of a string expression, and whether it is the whole string. */
function literalPrefix(node: AnyNode): { prefix: string; complete: boolean } | undefined {
  if (node?.type === "Literal" && typeof node.value === "string")
    return { prefix: node.value, complete: true };
  if (node?.type === "TemplateLiteral") {
    const head = node.quasis?.[0]?.value?.cooked;
    if (typeof head !== "string") return undefined;
    return { prefix: head, complete: node.expressions.length === 0 };
  }
  if (node?.type === "BinaryExpression" && node.operator === "+") {
    const left = literalPrefix(node.left);
    if (!left) return undefined;
    if (!left.complete) return left;
    const right = literalPrefix(node.right);
    return right
      ? { prefix: left.prefix + right.prefix, complete: right.complete }
      : { prefix: left.prefix, complete: false };
  }
  return undefined;
}

function report(ctx: RuleContext, call: AnyNode, url: { prefix: string; complete: boolean }) {
  const shown = url.complete ? url.prefix : `${url.prefix}…`;
  ctx.report(
    diagnostics.NUXT0101({
      why: `navigateTo('${shown}') navigates to an external URL without { external: true }. navigateTo treats any URL with a protocol, or starting with //, as external and throws instead of navigating unless the call allows it, so this call fails at runtime with NUXT_E2001.`,
      fix: `Pass { external: true } as the second argument: navigateTo('${shown}', { external: true }).`,
    }),
    {
      ruleId: RULE_ID,
      severity: ctx.severity,
      category: "routing",
      file: ctx.file.path,
      range: ctx.helpers.rangeFromOffsets(ctx.file.path, ctx.file.text, call.start, call.end),
      confidence: "heuristic-high",
    },
  );
}
