import { createHash } from "node:crypto";
import {
  createRule,
  type FixEdit,
  type RuleContext,
  type RuleVisitor,
  type ScriptAstNodeType,
} from "../../../core/index.js";
import { doctorInternalDiagnostics } from "../../../core/internal-diagnostic-handles.js";
import { containsInlineSuppression } from "../../../core/internal/suppression-syntax.js";
import { diagnostics } from "../diagnostics.js";
import {
  dropJsxTextChanges,
  planCommentDeletions,
  scriptDeletions,
  touchesTemplateBoundaries,
  type LineScopedComment,
} from "./comment-deletion.js";
import { safetyNoteComments } from "./safety-comment.js";
import {
  isTypeScriptSource,
  parentOf,
  scriptComments,
  type AnyNode,
  type ScriptComment,
} from "./shared.js";

const ruleId = "typescript/strict/no-comments";

const toolDirective =
  /^[\s*]*(?:@ts-|eslint[\s-]|oxlint-|(?:nuxt-|vite-)doctor-(?:disable|enable)\b|doctor-enable\b|(?:prettier|oxfmt|dprint|biome)-ignore|[#@]__(?:PURE|NO_SIDE_EFFECTS)__|@vite-ignore|webpack[A-Z]\w*\s*:|@vitest-environment|(?:v8|c8|istanbul)\s+ignore|@jsx|[#@]\s*source(?:Mapping)?URL=|!)/;
const lineScopedDirective =
  /^[\s*]*(?:@ts-|eslint[\s-]|oxlint-|(?:nuxt-|vite-)doctor-(?:disable|enable)\b|doctor-enable\b|(?:prettier|oxfmt|dprint|biome)-ignore|(?:v8|c8|istanbul)\s+ignore|@vue-ignore\b)/;
const countedCoverage = /^[\s*]*(?:v8|c8)\s+ignore\s+next\s+(\d+)\b/;
const templateDirective =
  /^\s*@vue-(?:(?:ignore|expect-error|skip)(?![-\w])|generic\s*\{[\s\S]*\}\s*$)/;
const blockDirective = /^\s*(?:globals?|exported)\s/;
const tripleSlash = /^\/\s*<(?:reference|amd-module|amd-dependency)\b/;
const preserved = /@(?:license|preserve)\b/;
const checkJsTag =
  /@(?:type|satisfies|typedef|callback|param|arg|argument|returns?|property|prop|this|enum|extends|augments|implements|template|import|overload|readonly|public|private|protected|override|abstract|class|constructor)\b/;

const reason = "This comment does not match a known directive or an allowed comment pattern.";
const removal =
  "When removing a script or JSX comment, preserve its line breaks and use a space if the comment separates tokens.";
const deleteMessage =
  "Delete the comment. Classify it first: move a decision to the decision log and file an issue for a workaround before deleting it.";

const apiMembers = [
  "AccessorProperty",
  "MethodDefinition",
  "PropertyDefinition",
  "TSAbstractMethodDefinition",
  "TSAbstractPropertyDefinition",
  "TSCallSignatureDeclaration",
  "TSConstructSignatureDeclaration",
  "TSEnumMember",
  "TSIndexSignature",
  "TSMethodSignature",
  "TSPropertySignature",
] as const satisfies readonly ScriptAstNodeType[];

interface NoCommentsOptions {
  allow: RegExp[];
  apiDocs: "exported" | "none";
}

const defaultOptions: NoCommentsOptions = { allow: [], apiDocs: "exported" };
const parsedOptions = new WeakMap<object, NoCommentsOptions>();

export const noComments = createRule({
  meta: {
    id: ruleId,
    title: "Report comments without a recognized exemption",
    description:
      "Report script, JSX, and Vue template comments that do not match a known directive or configured exemption. Opt-in: no Preset turns it on.",
    why: "A comment that repeats the code goes stale when the code changes, and agents read stale comments as facts. The Rule recognizes common compiler, linter, formatter, and coverage directives, bundler annotations such as `#__PURE__` and `@vite-ignore`, triple-slash references, `/*!`, `@license` and `@preserve` comments, source map comments, SAFETY notes, semantic JSDoc, and, by default, JSDoc on exported declarations and their members. Use `allow` for comments that other project tools consume.",
    recommendedReplacement:
      "Check whether a project tool reads the comment before removing it; if it does, add a pattern to allow it. Move non-obvious decisions to the project's decision log and file issues for workarounds before removing their comments. When removing a script or JSX comment, preserve its line breaks and use a space if the comment separates tokens.",
    examples: [
      {
        title: "Name the code instead of describing it",
        language: "ts",
        invalid:
          "// Retry three times before giving up.\nfor (let attempt = 0; attempt < 3; attempt++) await send()",
        valid:
          "const maxSendAttempts = 3\nfor (let attempt = 0; attempt < maxSendAttempts; attempt++) await send()",
      },
    ],
    category: "strict",
    severity: "warn",
    confidence: "proven",
    fixable: "unsafe",
    docsUrl: "https://vite-doctor.onmax.me/typescript#delete-comments-no-tool-reads",
    aiGeneratedCodeRisk: "high",
  },
  validateOptions: readOptions,
  create(ctx) {
    const options = readOptions(ctx.options);
    const source = ctx.file.text;
    const comments = scriptComments(ctx);
    const template = ctx.file.isVueSfc && source.includes("<!--");
    if (!comments.length && !template) return;

    const report = (start: number, end: number, edit?: FixEdit) =>
      ctx.report(
        diagnostics.TS0017({
          why: reason,
          fix: `Check whether a project tool reads it. If so, add an allow pattern. Otherwise, record decisions or file issues for workarounds before removing it. ${removal}`,
        }),
        {
          range: ctx.range(start, end),
          fingerprint: fingerprint(ctx, source.slice(start, end)),
          fix: edit ? { kind: "unsafe", message: deleteMessage, edits: [edit] } : undefined,
        },
      );
    const allowed = (text: string) => options.allow.some((pattern) => pattern.test(text));

    const visitor: RuleVisitor = {};
    if (template) {
      let pre = 0;
      visitor.template = {
        element(node) {
          if (node.tag === "pre") pre++;
        },
        "element:exit"(node) {
          if (node.tag === "pre") pre--;
        },
        comment(node, parent) {
          if (
            toolDirective.test(node.content) ||
            templateDirective.test(node.content) ||
            containsInlineSuppression(node.content) ||
            allowed(node.content)
          )
            return;
          const start = node.loc.start.offset;
          const end = node.loc.end.offset;
          const edit =
            !pre && touchesTemplateBoundaries(source, parent.children, node)
              ? { range: { start, end }, text: "" }
              : undefined;
          report(start, end, edit);
        },
      };
    }
    if (!comments.length) return visitor;

    const apiDocs = new Set<ScriptComment>();
    if (options.apiDocs === "exported" && comments.some(isJsDoc)) {
      let exported = new Set<AnyNode>();
      const keepApiDoc = (start: number) => {
        const doc = jsDocBefore(source, comments, start);
        if (doc) apiDocs.add(doc);
      };
      visitor.Program = (program) => {
        exported = exportedDeclarations(program.body, keepApiDoc);
      };
      const keepMemberDoc = (node: AnyNode) => {
        if (belongsToExport(node, exported)) keepApiDoc(documentedStart(source, node));
      };
      for (const type of apiMembers) visitor[type] = keepMemberDoc;
      visitor.TSUnionType = (node: AnyNode) => {
        for (const member of node.types) keepMemberDoc(member);
      };
    }

    const jsxComments: AnyNode[] = [];
    visitor.JSXExpressionContainer = (node: AnyNode) => {
      if (node.expression.type === "JSXEmptyExpression") jsxComments.push(node);
    };

    const javascript = !isTypeScriptSource(ctx);
    visitor["Program:exit"] = () => {
      const safetyNotes = safetyNoteComments(source, comments);
      const lineScopedComments: LineScopedComment[] = [];
      const found = comments.filter((comment) => {
        const { value, end } = comment;
        if (isToolComment(comment, javascript) || allowed(value)) {
          const count = countedCoverage.exec(value)?.[1];
          if (count !== undefined) {
            lineScopedComments.push({ end, lineBreaks: Math.max(2, Number(count) + 1) });
          } else if (
            lineScopedDirective.test(value) ||
            containsInlineSuppression(value) ||
            allowed(value)
          ) {
            lineScopedComments.push({ end, lineBreaks: 2 });
          }
          return false;
        }
        return (
          !(comment.start === 0 && source.startsWith("#!")) &&
          !safetyNotes.has(comment) &&
          !apiDocs.has(comment)
        );
      });
      const deletions = scriptDeletions(comments, found, jsxComments);
      const edits = planCommentDeletions(
        source,
        [...new Set(deletions.values())],
        lineScopedComments,
      );
      dropJsxTextChanges(source, jsxComments, deletions, edits);
      for (const comment of found)
        report(comment.start, comment.end, edits.get(deletions.get(comment)!));
    };
    return visitor;
  },
});

function isToolComment(comment: ScriptComment, javascript: boolean): boolean {
  const { value } = comment;
  if (
    toolDirective.test(value) ||
    /^[\s*]*@vue-ignore\b/.test(value) ||
    preserved.test(value) ||
    containsInlineSuppression(value)
  )
    return true;
  if (value.includes("@internal")) return true;
  if (comment.type === "Line") return tripleSlash.test(value);
  return blockDirective.test(value) || (javascript && isJsDoc(comment) && checkJsTag.test(value));
}

function isJsDoc(comment: ScriptComment): boolean {
  return comment.type === "Block" && comment.value.startsWith("*");
}

// A union member's JSDoc sits before its `|`.
function documentedStart(source: string, node: AnyNode): number {
  if (parentOf(node)?.type !== "TSUnionType") return node.start;
  let index = node.start - 1;
  while (index >= 0 && /\s/.test(source[index]!)) index--;
  return source[index] === "|" ? index : node.start;
}

function jsDocBefore(
  source: string,
  comments: ScriptComment[],
  start: number,
): ScriptComment | undefined {
  let low = 0;
  let high = comments.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (comments[middle]!.end <= start) low = middle + 1;
    else high = middle;
  }
  const doc = comments[low - 1];
  if (!doc || !isJsDoc(doc) || /\S/.test(source.slice(doc.end, start))) return undefined;
  return doc;
}

function exportedDeclarations(body: AnyNode[], keepApiDoc: (start: number) => void) {
  const declarations = new Set<AnyNode>();
  const names = new Set<string>();
  for (const statement of body) {
    if (statement.type === "ExportNamedDeclaration") {
      keepApiDoc(statement.start);
      if (statement.declaration) declarations.add(statement.declaration);
      if (!statement.source) {
        for (const specifier of statement.specifiers) names.add(specifier.local.name);
      }
    } else if (statement.type === "ExportDefaultDeclaration") {
      keepApiDoc(statement.start);
      if (statement.declaration.type === "Identifier") names.add(statement.declaration.name);
      else declarations.add(statement.declaration);
    }
  }
  for (const statement of body) {
    if (
      isExportedBinding(statement.id, names) ||
      (statement.type === "VariableDeclaration" &&
        statement.declarations.some((item: AnyNode) => isExportedBinding(item.id, names)))
    ) {
      keepApiDoc(statement.start);
      declarations.add(statement);
    }
  }
  return declarations;
}

function isExportedBinding(pattern: AnyNode, names: Set<string>): boolean {
  switch (pattern?.type) {
    case "Identifier":
      return names.has(pattern.name);
    case "ObjectPattern":
      return pattern.properties.some((property: AnyNode) =>
        isExportedBinding(
          property.type === "RestElement" ? property.argument : property.value,
          names,
        ),
      );
    case "ArrayPattern":
      return pattern.elements.some((element: AnyNode) => isExportedBinding(element, names));
    case "AssignmentPattern":
      return isExportedBinding(pattern.left, names);
    case "RestElement":
      return isExportedBinding(pattern.argument, names);
    default:
      return false;
  }
}

function belongsToExport(node: AnyNode, exported: Set<AnyNode>): boolean {
  for (let current = node; current; current = parentOf(current)) {
    if (exported.has(current)) return true;
    const parent = parentOf(current);
    if (!parent) return false;
    if (
      parent.type === "BlockStatement" ||
      parent.type === "StaticBlock" ||
      ((parent.type === "ArrowFunctionExpression" || parent.type === "FunctionExpression") &&
        parent.body === current)
    )
      return false;
  }
  return false;
}

// The default fingerprint names the nearest declaration above the finding, so renaming a
// function or adding a `const` above would make every old comment new under `--new-only`.
function fingerprint(ctx: RuleContext, text: string): string {
  return createHash("sha256")
    .update(`${ruleId}\0${ctx.file.relativePath}\0${text.replace(/\s+/g, " ").trim()}`)
    .digest("hex");
}

function readOptions(options: unknown): NoCommentsOptions {
  if (options === undefined) return defaultOptions;
  const invalid = (reason: string) => doctorInternalDiagnostics.DOC0020({ ruleId, reason });
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw invalid("options must be an object with `allow` and `apiDocs`");
  const cached = parsedOptions.get(options);
  if (cached) return cached;
  const { allow = [], apiDocs = "exported", ...unknown } = options as Record<string, unknown>;
  const extra = Object.keys(unknown);
  if (extra.length) throw invalid(`unknown option ${extra.map((key) => `\`${key}\``).join(", ")}`);
  if (apiDocs !== "exported" && apiDocs !== "none")
    throw invalid('`apiDocs` must be "exported" or "none"');
  if (!Array.isArray(allow) || allow.some((pattern) => typeof pattern !== "string"))
    throw invalid("`allow` must be an array of regular expression sources");
  const parsed: NoCommentsOptions = {
    apiDocs,
    allow: allow.map((pattern: string, index) => {
      try {
        return new RegExp(pattern);
      } catch (error) {
        throw invalid(
          `\`allow[${index}]\` is not a valid regular expression: ${(error as Error).message}`,
        );
      }
    }),
  };
  parsedOptions.set(options, parsed);
  return parsed;
}
