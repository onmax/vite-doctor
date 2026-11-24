import type { RuleContext } from "../../../../core/index.js";
import {
  moduleNames,
  resolvesToModuleBinding,
  unwrapExpression,
} from "../../../../core/internal/request-values.js";
import { nearestFunctionOrProgram, type AnyNode } from "./shared.js";

export interface SourceRange {
  start: number;
  end: number;
}

// `<script setup>` bindings belong to one component instance and its top level runs on every
// render; only a plain `<script>` block is evaluated once per module.
export function blockRange(ctx: RuleContext, block: "script" | "scriptSetup"): SourceRange | null {
  const loc = (ctx.sfc?.descriptor as AnyNode)?.[block]?.loc;
  return loc ? { start: loc.start.offset, end: loc.end.offset } : null;
}

export function inRange(node: AnyNode, range: SourceRange | null) {
  return Boolean(range && node.start >= range.start && node.end <= range.end);
}

/** The range that holds module-scope declarations: the plain `<script>` block of an SFC. */
export function moduleScriptRange(ctx: RuleContext): SourceRange | null {
  return ctx.file.relativePath.endsWith(".vue")
    ? blockRange(ctx, "script")
    : { start: 0, end: Infinity };
}

/** A write that can run while the server renders a request, as far as the file shows. */
export function isRequestTimeWrite(ctx: RuleContext, node: AnyNode, setup: SourceRange | null) {
  if (nearestFunctionOrProgram(node)?.type === "Program" && !inRange(node, setup)) return false;
  if (followsServerReturn(ctx, node)) return false;
  return !ctx.helpers.isClientOnlyExecutionContext(node, ctx.file.text);
}

// An `if (import.meta.server) return` earlier in an enclosing block, including the blocks of
// functions that register the callback holding the write.
function followsServerReturn(ctx: RuleContext, node: AnyNode) {
  for (let child = node, current = node.__doctorParent; current;) {
    if (current.type === "BlockStatement" || current.type === "Program") {
      for (const statement of current.body) {
        if (statement === child) break;
        if (isServerReturnGuard(ctx, statement)) return true;
      }
    }
    child = current;
    current = current.__doctorParent;
  }
  return false;
}

function isServerReturnGuard(ctx: RuleContext, statement: AnyNode) {
  if (statement.type !== "IfStatement") return false;
  const exit =
    statement.consequent.type === "BlockStatement"
      ? statement.consequent.body[0]
      : statement.consequent;
  return exit?.type === "ReturnStatement" && isServerTest(ctx, unwrapExpression(statement.test));
}

function isServerTest(ctx: RuleContext, test: AnyNode): boolean {
  if (test?.type === "LogicalExpression" && test.operator === "||")
    return (
      isServerTest(ctx, unwrapExpression(test.left)) ||
      isServerTest(ctx, unwrapExpression(test.right))
    );
  const text = ctx.file.text.slice(test.start, test.end);
  return (
    text === "import.meta.server" ||
    /^typeof\s+(?:window|document|localStorage|sessionStorage|navigator)\s*={2,3}\s*["']undefined["']$/.test(
      text,
    )
  );
}

/**
 * The name `callee` imports when it resolves to an import whose source `fromSource` accepts, or to
 * a Nuxt auto-import from such a source. Null for locals, other modules, and unproven globals.
 */
export function importedName(
  ctx: RuleContext,
  callee: AnyNode,
  fromSource: (source: string) => boolean,
): string | null {
  if (callee?.type !== "Identifier" || !resolvesToModuleBinding(callee, callee.name)) return null;
  let program = callee;
  while (program.__doctorParent) program = program.__doctorParent;
  for (const statement of program.body ?? []) {
    if (statement.type !== "ImportDeclaration") continue;
    for (const specifier of statement.specifiers ?? []) {
      if (specifier.local?.name !== callee.name) continue;
      if (statement.importKind === "type" || specifier.importKind === "type") return null;
      if (specifier.type !== "ImportSpecifier" || !fromSource(String(statement.source.value)))
        return null;
      return String(specifier.imported?.name ?? specifier.imported?.value);
    }
  }
  if (moduleNames(callee).has(callee.name)) return null;
  const nuxt = ctx.project.nuxt;
  if (!nuxt?.autoImportEnabled) return null;
  const entry = nuxt.autoImports.get(callee.name);
  if (entry) return fromSource(entry.from) ? entry.name : null;
  return nuxt.autoImportsAuthoritative ? null : callee.name;
}
