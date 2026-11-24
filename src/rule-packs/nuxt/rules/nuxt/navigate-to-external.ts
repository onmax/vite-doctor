import type { RuleContext } from "../../../../core/index.js";
import { diagnostics } from "../../diagnostics.js";
import { AnyNode, createRule, isRuntimeAppFile, walkScriptLocal } from "./shared.js";

const RULE_ID = "nuxt/routing/navigate-to-external";
// ufo's hasProtocol(toPath, { acceptRelative: true }), which navigateTo uses to spot external URLs.
const PROTOCOL = /^[\s\w\0+.-]{2,}:([/\\]{2})?/;
const PROTOCOL_RELATIVE = /^([/\\]\s*){2,}[^/\\]/;
// With `external: true` these still throw (NUXT_E2002), so adding the option would not help.
const SCRIPT_PROTOCOL = /^[\s\0]*(?:blob|data|javascript|vbscript):/i;
const NUXT_SOURCES = new Set(["#app", "#imports", "nuxt/app", "#app/composables/router"]);
const NUXT_AUTO_IMPORT_SOURCE =
  /^(?:#app|#imports|nuxt\/app|nuxt)(?:\/|$)|(?:^|\/)nuxt\/dist\/app\//;

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
    const binding = topLevelBinding(ctx.file.scriptAst);
    const check = (call: AnyNode) => {
      const url = externalUrl(call);
      if (url) report(ctx, call, url);
    };
    return {
      CallExpression(node: AnyNode) {
        if (node.callee?.type !== "Identifier" || node.callee.name !== "navigateTo") return;
        const local = ctx.helpers.hasLocalBinding(node.callee);
        if (local ? binding === "nuxt" : isNuxtAutoImport(ctx)) check(node);
      },
      template: {
        directive(node) {
          if (!node.exp || binding === "other" || (!binding && !isNuxtAutoImport(ctx))) return;
          const expression = ctx.helpers.parseTemplateExpression(node.exp);
          walkScriptLocal(expression, (child) => {
            if (
              child.type === "CallExpression" &&
              child.callee?.type === "Identifier" &&
              child.callee.name === "navigateTo"
            )
              check(child);
          });
        },
      },
    };
  },
});

/** Whether the module declares `navigateTo` itself, as an import from Nuxt or as anything else. */
function topLevelBinding(program: AnyNode): "nuxt" | "other" | undefined {
  for (const statement of program?.body ?? []) {
    if (statement.type === "ImportDeclaration") {
      for (const specifier of statement.specifiers ?? []) {
        if (specifier.local?.name !== "navigateTo") continue;
        const imported = specifier.imported?.name ?? specifier.imported?.value;
        return specifier.type === "ImportSpecifier" &&
          imported === "navigateTo" &&
          NUXT_SOURCES.has(statement.source.value)
          ? "nuxt"
          : "other";
      }
      continue;
    }
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "FunctionDeclaration" && declaration.id?.name === "navigateTo")
      return "other";
    if (
      declaration?.type === "VariableDeclaration" &&
      declaration.declarations.some((item: AnyNode) => patternNames(item.id).includes("navigateTo"))
    )
      return "other";
  }
  return undefined;
}

function patternNames(pattern: AnyNode): string[] {
  switch (pattern?.type) {
    case "Identifier":
      return [pattern.name];
    case "ObjectPattern":
      return pattern.properties.flatMap((property: AnyNode) =>
        patternNames(property.type === "RestElement" ? property.argument : property.value),
      );
    case "ArrayPattern":
      return pattern.elements.flatMap(patternNames);
    case "AssignmentPattern":
      return patternNames(pattern.left);
    case "RestElement":
      return patternNames(pattern.argument);
    default:
      return [];
  }
}

function isNuxtAutoImport(ctx: RuleContext): boolean {
  const nuxt = ctx.project.nuxt;
  if (!nuxt?.autoImportEnabled) return false;
  const entry = nuxt.autoImports.get("navigateTo");
  if (!entry) return !nuxt.autoImportsAuthoritative;
  return entry.name === "navigateTo" && NUXT_AUTO_IMPORT_SOURCE.test(entry.from);
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
