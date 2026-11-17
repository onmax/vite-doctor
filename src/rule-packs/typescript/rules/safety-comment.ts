import type { RuleContext } from "../../../core/index.js";
import { createTypeAliasResolver } from "./type-aliases.js";
import { parentOf, type AnyNode } from "./shared.js";

const commentOwners = new Set([
  "ExpressionStatement",
  "IfStatement",
  "PropertyDefinition",
  "ReturnStatement",
  "ThrowStatement",
  "VariableDeclaration",
]);

const loops = new Set([
  "DoWhileStatement",
  "ForInStatement",
  "ForOfStatement",
  "ForStatement",
  "WhileStatement",
]);

const typeResolvers = new WeakMap<object, ReturnType<typeof createTypeAliasResolver>>();

const vueModules = new Set(["vue", "@vue/runtime-core"]);

// A comment above a line that continues a ternary, a logical chain, or an `else`, or
// that opens with a `;` guarding an ASI hazard, still sits directly before the code it explains.
const branchToken = /^\s*(?:;|\?\?|\?|:|&&|\|\||else\b)?\s*$/;
const plainGap = /^\s*;?\s*$/;

export function hasSafetyComment(ctx: RuleContext, node: AnyNode): boolean {
  const source = ctx.file.text;
  const comments = (ctx.file.scriptAst?.comments as AnyNode[] | undefined) ?? [];
  return (
    hasSafetyCommentBeforeOwner(source, comments, node) ||
    hasSafetyCommentAboveLine(source, comments, node)
  );
}

function hasSafetyCommentBeforeOwner(source: string, comments: AnyNode[], node: AnyNode): boolean {
  let current = node;
  while (current && current.type !== "Program") {
    const parent = parentOf(current);
    const gap = continuesBranch(current, parent) ? branchToken : plainGap;
    if (hasSafetyCommentBefore(source, comments, current.start, gap)) return true;
    if (parent?.body === current && loops.has(parent.type)) return false;
    if (parent?.type === "IfStatement" && parent.alternate === current) return false;
    if (commentOwners.has(current.type)) {
      const exported = parent?.type === "ExportNamedDeclaration" && parent.declaration === current;
      const loopInitializer =
        current.type === "VariableDeclaration" &&
        ((parent?.type === "ForStatement" && parent.init === current) ||
          ((parent?.type === "ForOfStatement" || parent?.type === "ForInStatement") &&
            parent.left === current));
      const ifBody = parent?.type === "IfStatement" && parent.consequent === current;
      if (!exported && !loopInitializer && !ifBody) return false;
    }
    current = parent;
  }
  return false;
}

// A comment on its own line covers the next line, unless an unrelated statement starts
// on that line before the assertion or the assertion sits in a loop body or `else` branch.
function hasSafetyCommentAboveLine(source: string, comments: AnyNode[], node: AnyNode): boolean {
  const lineStart = source.lastIndexOf("\n", node.start - 1) + 1;
  const lineCode =
    lineStart + /^[ \t]*(?:;[ \t]*)?/.exec(source.slice(lineStart, node.start))![0].length;
  if (!hasSafetyCommentBefore(source, comments, lineCode, plainGap, true)) return false;
  let current = node;
  while (current.start > lineCode) {
    const parent = parentOf(current);
    if (!parent) return false;
    if (parent.body === current && loops.has(parent.type)) return false;
    if (parent.type === "IfStatement" && parent.alternate === current) return false;
    for (const statements of [parent.body, parent.consequent]) {
      if (!Array.isArray(statements)) continue;
      for (const statement of statements) {
        if (statement === current) break;
        if (statement.start >= lineCode) return false;
      }
    }
    current = parent;
  }
  return true;
}

function continuesBranch(node: AnyNode, parent: AnyNode): boolean {
  return (
    (parent?.type === "ConditionalExpression" &&
      (parent.consequent === node || parent.alternate === node)) ||
    (parent?.type === "LogicalExpression" && parent.right === node) ||
    (parent?.type === "IfStatement" && parent.alternate === node)
  );
}

function hasSafetyCommentBefore(
  source: string,
  comments: AnyNode[],
  start: number,
  firstGap: RegExp,
  standalone = false,
): boolean {
  let before = start;
  let low = 0;
  let high = comments.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (comments[middle]!.end <= before) low = middle + 1;
    else high = middle;
  }
  let value = "";
  let gapPattern = firstGap;
  for (let index = low - 1; index >= 0; index--) {
    const comment = comments[index]!;
    const gap = source.slice(comment.end, before);
    if (!gapPattern.test(gap)) return false;
    // The branch token can occupy its own line, but neither side may contain a blank line.
    const gaps = gapPattern === branchToken ? gap.split(/;|\?\?|\?|:|&&|\|\||else\b/) : [gap];
    if (gaps.some((part) => (part.match(/\r\n|\r|\n/g)?.length ?? 0) > 1)) return false;
    if (standalone) {
      const lineStart = source.lastIndexOf("\n", comment.start - 1) + 1;
      if (!/^\s*$/.test(source.slice(lineStart, comment.start))) return false;
    }
    value = `${comment.value.replace(/^[ \t]*\*[ \t]?/gm, "")}\n${value}`;
    if (/(?:^|[^\p{L}\p{N}_])SAFETY\s*:\s*\S/u.test(value)) return true;
    before = comment.start;
    gapPattern = /^\s*$/;
  }
  return false;
}

export function isVuePropTypeAssertion(ctx: RuleContext, node: AnyNode): boolean {
  const annotation = node?.typeAnnotation;
  if (annotation?.type !== "TSTypeReference") return false;
  const name = annotation.typeName;
  const program = ctx.file.scriptAst;
  if (!program) return false;
  let resolver = typeResolvers.get(program);
  if (!resolver) {
    resolver = createTypeAliasResolver(program);
    typeResolvers.set(program, resolver);
  }
  const namespace = name?.type === "TSQualifiedName";
  const referenced = namespace ? name.left : name;
  if (referenced?.type !== "Identifier") return false;
  const binding = resolver.rootBinding(annotation, referenced.name, namespace);
  const body = (program.body as AnyNode[] | undefined) ?? [];
  for (const statement of body) {
    if (statement.type !== "ImportDeclaration" || !vueModules.has(statement.source?.value)) {
      continue;
    }
    for (const specifier of statement.specifiers ?? []) {
      if (specifier !== binding) continue;
      if (
        name?.type === "Identifier" &&
        specifier.type === "ImportSpecifier" &&
        importedName(specifier) === "PropType" &&
        specifier.local?.name === name.name
      ) {
        return true;
      }
      if (
        name?.type === "TSQualifiedName" &&
        name.left?.type === "Identifier" &&
        name.right?.name === "PropType" &&
        specifier.type === "ImportNamespaceSpecifier" &&
        specifier.local?.name === name.left.name
      ) {
        return true;
      }
    }
  }
  return false;
}

function importedName(specifier: AnyNode): string | undefined {
  return specifier.imported?.name ?? specifier.imported?.value;
}
