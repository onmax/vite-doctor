import { createHash } from "node:crypto";
import {
  createRule,
  type RuleContext,
  type RuleVisitor,
  type ScriptAstNodeType,
} from "../../../core/index.js";
import { doctorInternalDiagnostics } from "../../../core/internal-diagnostic-handles.js";
import { diagnostics } from "../diagnostics.js";
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
  /^[\s*]*(?:@ts-|eslint[\s-]|oxlint-|(?:nuxt-|vite-)?doctor-(?:disable|enable)|(?:prettier|oxfmt|dprint|biome)-ignore|[#@]__(?:PURE|NO_SIDE_EFFECTS)__|@vite-ignore|@vue-ignore|webpack[A-Z]\w*\s*:|@vitest-environment|(?:v8|c8|istanbul)\s+ignore|@jsx|[#@]\s*source(?:Mapping)?URL=|!)/;
const blockDirective = /^[\s*]*globals?\s/;
const tripleSlash = /^\/\s*<(?:reference|amd-module|amd-dependency)\b/;
const preserved = /@(?:license|preserve)\b/;
const checkJsTag =
  /@(?:type|satisfies|typedef|callback|param|arg|argument|returns?|property|prop|this|enum|extends|augments|implements)\s*\{|@(?:template|import|overload)\b/;

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
    title: "Delete comments no tool reads",
    description:
      "Report every script, JSX, and Vue template comment that no compiler, linter, formatter, bundler, coverage tool, or Doctor Rule reads. Opt-in: no Preset turns it on.",
    why: "No tool reads this comment, so nothing checks that it stays true. A comment that repeats the code goes stale when the code changes, and agents read stale comments as facts. The Rule keeps comments a tool reads: compiler, linter, formatter, and coverage directives, bundler annotations such as `#__PURE__` and `@vite-ignore`, triple-slash references, `/*!`, `@license` and `@preserve` comments, source map comments, SAFETY notes that `typescript/strict/require-safety-comment-for-type-assertion` reads, typed JSDoc in JavaScript files, and, by default, JSDoc on exported declarations and their members. The `allow` option keeps comments that a project's own tools read.",
    recommendedReplacement:
      "Classify the comment before deleting it. Delete a Tautology, which repeats what the code says, and a Stale comment, which is no longer true. For an Excuse, which allows a workaround, file an issue first. For a Decision Record, a non-obvious decision the code cannot show, move it to the project's decision log first. Then delete the comment.",
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
    fixable: false,
    docsUrl: "https://vite-doctor.onmax.me/typescript#delete-comments-no-tool-reads",
    aiGeneratedCodeRisk: "high",
  },
  create(ctx) {
    const options = readOptions(ctx.options);
    const source = ctx.file.text;
    const comments = scriptComments(ctx);
    const template = ctx.file.isVueSfc && source.includes("<!--");
    if (!comments.length && !template) return;

    const report = (start: number, end: number) =>
      ctx.report(
        diagnostics.TS0017({
          why: "No tool reads this comment, so nothing checks that it stays true.",
          fix: "Delete it. First move a decision the code cannot show into the project's decision log, and file an issue for a workaround it excuses.",
        }),
        { range: ctx.range(start, end), fingerprint: fingerprint(ctx, source.slice(start, end)) },
      );
    const allowed = (text: string) => options.allow.some((pattern) => pattern.test(text));

    const visitor: RuleVisitor = {};
    if (template) {
      visitor.template = {
        comment(node) {
          if (toolDirective.test(node.content) || allowed(node.content)) return;
          report(node.loc.start.offset, node.loc.end.offset);
        },
      };
    }
    if (!comments.length) return visitor;

    const apiDocs = new Set<ScriptComment>();
    if (options.apiDocs === "exported" && comments.some(isJsDoc)) {
      const keepApiDoc = (node: AnyNode) => {
        const doc = jsDocBefore(source, comments, documentedStart(source, node));
        if (doc && isExported(node)) apiDocs.add(doc);
      };
      visitor.ExportNamedDeclaration = keepApiDoc;
      visitor.ExportDefaultDeclaration = keepApiDoc;
      for (const type of apiMembers) visitor[type] = keepApiDoc;
      visitor.TSUnionType = (node: AnyNode) => {
        for (const member of node.types) keepApiDoc(member);
      };
    }

    const javascript = !isTypeScriptSource(ctx);
    visitor["Program:exit"] = () => {
      const safetyNotes = safetyNoteComments(source, comments);
      for (const comment of comments) {
        if (comment.start === 0 && source.startsWith("#!")) continue;
        if (safetyNotes.has(comment) || apiDocs.has(comment)) continue;
        if (isToolComment(comment, javascript) || allowed(comment.value)) continue;
        report(comment.start, comment.end);
      }
    };
    return visitor;
  },
});

function isToolComment(comment: ScriptComment, javascript: boolean): boolean {
  const { value } = comment;
  if (toolDirective.test(value) || preserved.test(value)) return true;
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

function isExported(node: AnyNode): boolean {
  for (let current = node; current; current = parentOf(current)) {
    if (current.type === "ExportNamedDeclaration" || current.type === "ExportDefaultDeclaration")
      return true;
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
