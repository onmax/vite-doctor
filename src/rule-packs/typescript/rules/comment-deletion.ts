import type { FixEdit, TemplateChildNode } from "../../../core/index.js";
import { parentOf, type AnyNode, type ScriptComment } from "./shared.js";

/**
 * A reported script comment, a JSX expression container that holds only comments, or a Vue
 * template comment. Script comments sit between tokens; the others between rendered children.
 */
export interface CommentDeletion {
  start: number;
  end: number;
  kind: "script" | "jsx" | "template";
}

interface LineGroup {
  members: CommentDeletion[];
  start: number;
  end: number;
}

const lineBreak = /[\n\r\u2028\u2029]/;
// A comment between one of these and another token never joins two tokens into one.
const tokenEdges = new Set(["(", ")", "[", "]", "{", "}", ",", ";"]);
const openingLine = /(?:[{([]|^<[A-Za-z][^<>]*(?<!\/)>)$/;
const closingLine = /^(?:[})\]]|<\/)/;

/**
 * Plans one edit per deletion, all against the same source, so they compose in one fix pass.
 * Deletions that share a line, or whole lines separated only by blank lines, are planned
 * together so that applying them all leaves no stray indentation, no double blank line, and no
 * new blank line at the edge of a block or file. A deletion without an edit is not safe to
 * automate. Deletions must be sorted by start and must not overlap.
 */
export function planCommentDeletions(
  source: string,
  deletions: readonly CommentDeletion[],
): Map<CommentDeletion, FixEdit> {
  const edits = new Map<CommentDeletion, FixEdit>();
  const wholeLines: LineGroup[] = [];
  for (const members of sameLineGroups(source, deletions)) {
    const first = members[0]!;
    const last = members.at(-1)!;
    const lineStart = lineStartAt(source, first.start);
    const lineEnd = lineEndAt(source, last.end);
    const before = source.slice(lineStart, first.start);
    const after = source.slice(last.end, lineEnd);
    const codeBefore = before.trim() !== "";
    const codeAfter = after.trim() !== "";
    const spaceBefore = /[ \t]*$/.exec(before)![0].length;
    const spaceAfter = /^[ \t]*/.exec(after)![0].length;
    if (!codeBefore && !codeAfter) {
      wholeLines.push({ members, start: lineStart, end: nextLineStart(source, lineEnd) });
    } else if (first.kind !== "script" && members.length > 1) {
      continue;
    } else if (!codeAfter) {
      partition(edits, members, first.start - spaceBefore, last.end);
    } else if (!codeBefore) {
      partition(edits, members, first.start, last.end + spaceAfter);
    } else if (first.kind === "jsx") {
      partition(edits, members, first.start, last.end);
    } else if (first.kind === "template") {
      // Whitespace beside a comment renders under `whitespace: "preserve"` and not under the
      // default "condense", so only a comment that touches its neighbours is safe to delete.
      if (!spaceBefore && !spaceAfter) partition(edits, members, first.start, last.end);
    } else if (!lineBreak.test(source.slice(first.start, last.end))) {
      // Code on both sides: a line break inside the comment could be the one that ends the
      // statement after `return` or `throw`, so only single-line comments get an edit.
      const start = first.start - spaceBefore;
      const end = last.end + spaceAfter;
      const separates = !tokenEdges.has(source[start - 1]!) && !tokenEdges.has(source[end]!);
      if (spaceBefore && spaceAfter) partition(edits, members, first.start, end);
      else if (!separates) partition(edits, members, start, end);
      else partition(edits, members, first.start, last.end, spaceBefore || spaceAfter ? "" : " ");
    }
  }
  for (const run of lineRuns(source, wholeLines)) planRun(source, run, edits);
  return edits;
}

/**
 * Maps each reported script comment to its deletion. A JSX comment container is deleted whole
 * when every comment inside it is reported, so no empty `{}` stays behind.
 */
export function scriptDeletions(
  comments: readonly ScriptComment[],
  reported: readonly ScriptComment[],
  jsxComments: readonly AnyNode[],
): Map<ScriptComment, CommentDeletion> {
  const found = new Set(reported);
  const containers = new Map<ScriptComment, CommentDeletion>();
  let index = 0;
  for (const container of jsxComments) {
    const parent = parentOf(container)?.type;
    if (parent !== "JSXElement" && parent !== "JSXFragment") continue;
    while (index < comments.length && comments[index]!.start < container.start) index++;
    const inside: ScriptComment[] = [];
    while (index < comments.length && comments[index]!.end <= container.end)
      inside.push(comments[index++]!);
    if (!inside.length || !inside.every((comment) => found.has(comment))) continue;
    const deletion: CommentDeletion = { start: container.start, end: container.end, kind: "jsx" };
    for (const comment of inside) containers.set(comment, deletion);
  }
  const deletions = new Map<ScriptComment, CommentDeletion>();
  for (const comment of reported)
    deletions.set(
      comment,
      containers.get(comment) ?? { start: comment.start, end: comment.end, kind: "script" },
    );
  return deletions;
}

/**
 * Drops the edits of JSX comment containers whose deletion would change the text a JSX element
 * renders, for example by turning a line break between two words into a space.
 */
export function dropJsxTextChanges(
  source: string,
  jsxComments: readonly AnyNode[],
  deletions: Map<ScriptComment, CommentDeletion>,
  edits: Map<CommentDeletion, FixEdit>,
): void {
  const byStart = new Map<number, CommentDeletion>();
  for (const deletion of deletions.values())
    if (deletion.kind === "jsx" && edits.has(deletion)) byStart.set(deletion.start, deletion);
  if (!byStart.size) return;
  const parents = new Set(
    jsxComments.filter((node) => byStart.has(node.start)).map((node) => parentOf(node)),
  );
  for (const parent of parents) {
    let run: AnyNode[] = [];
    for (const child of [...parent.children, undefined]) {
      if (
        child?.type === "JSXText" ||
        (child?.type === "JSXExpressionContainer" && byStart.has(child.start))
      ) {
        run.push(child);
        continue;
      }
      const removed = run.flatMap((node) => byStart.get(node.start) ?? []);
      if (removed.length && !keepsJsxText(source, run, removed, edits))
        for (const deletion of removed) edits.delete(deletion);
      run = [];
    }
  }
}

function keepsJsxText(
  source: string,
  run: AnyNode[],
  removed: CommentDeletion[],
  edits: Map<CommentDeletion, FixEdit>,
): boolean {
  const end = run.at(-1)!.end;
  let cursor = run[0]!.start;
  let after = "";
  for (const deletion of removed) {
    const { range, text } = edits.get(deletion)!;
    if (range.start < cursor || range.end > end) return false;
    after += source.slice(cursor, range.start) + text;
    cursor = range.end;
  }
  after += source.slice(cursor, end);
  // Joining two texts can complete an HTML entity.
  if (after.includes("&")) return false;
  const before = run
    .filter((node) => node.type === "JSXText")
    .map((node) => renderedJsxText(source.slice(node.start, node.end)))
    .join("");
  return renderedJsxText(after) === before;
}

// The whitespace rules JSX compilers apply to a text child.
function renderedJsxText(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/);
  let lastText = -1;
  lines.forEach((line, index) => {
    if (/[^ \t]/.test(line)) lastText = index;
  });
  let text = "";
  lines.forEach((line, index) => {
    let trimmed = line.replace(/\t/g, " ");
    if (index > 0) trimmed = trimmed.replace(/^ +/, "");
    if (index < lines.length - 1) trimmed = trimmed.replace(/ +$/, "");
    if (trimmed) text += index === lastText ? trimmed : `${trimmed} `;
  });
  return text;
}

/**
 * Whether Vue's default whitespace condensing drops the whitespace on both sides of a template
 * comment, so deleting the comment and its line leaves the rendered children unchanged.
 */
export function condensedAround(
  siblings: readonly TemplateChildNode[],
  comment: TemplateChildNode,
): boolean {
  const index = siblings.indexOf(comment);
  return [siblings[index - 1], siblings[index + 1]].every(
    (sibling) => !sibling || sibling.type === 1 || sibling.type === 3,
  );
}

function sameLineGroups(source: string, deletions: readonly CommentDeletion[]) {
  const groups: CommentDeletion[][] = [];
  let previous: CommentDeletion | undefined;
  for (const deletion of deletions) {
    if (
      previous?.kind === deletion.kind &&
      /^[ \t]*$/.test(source.slice(previous.end, deletion.start))
    )
      groups.at(-1)!.push(deletion);
    else groups.push([deletion]);
    previous = deletion;
  }
  return groups;
}

function lineRuns(source: string, groups: LineGroup[]) {
  const runs: LineGroup[][] = [];
  for (const group of groups) {
    const run = runs.at(-1);
    if (run && source.slice(run.at(-1)!.end, group.start).trim() === "") run.push(group);
    else runs.push([group]);
  }
  return runs;
}

// Blank lines around and between the deleted lines join the nearest deleted group, so the edits
// stay contiguous. One blank line survives unless the run touches a block or file edge.
function planRun(source: string, run: LineGroup[], edits: Map<CommentDeletion, FixEdit>) {
  const fileStart = source.startsWith("\uFEFF") ? 1 : 0;
  let top = run[0]!.start;
  while (top > fileStart) {
    const previous = lineStartAt(source, top - 1);
    if (source.slice(previous, top).trim() !== "") break;
    top = previous;
  }
  let bottom = run.at(-1)!.end;
  while (bottom < source.length) {
    const next = nextLineStart(source, lineEndAt(source, bottom));
    if (source.slice(bottom, next).trim() !== "") break;
    bottom = next;
  }
  const above = top > fileStart ? source.slice(lineStartAt(source, top - 1), top).trim() : "";
  const below =
    bottom < source.length ? source.slice(bottom, lineEndAt(source, bottom)).trim() : "";
  const edge =
    top <= fileStart ||
    bottom >= source.length ||
    openingLine.test(above) ||
    closingLine.test(below);

  const starts = run.map((_, index) => (index === 0 ? top : run[index - 1]!.end));
  let end = bottom;
  if (!edge) {
    const kept = starts.findIndex((start, index) => start < run[index]!.start);
    if (kept !== -1) starts[kept] = nextLineStart(source, lineEndAt(source, starts[kept]!));
    else if (bottom > run.at(-1)!.end) end = lineStartAt(source, bottom - 1);
  }
  run.forEach((group, index) =>
    partition(edits, group.members, starts[index]!, index === run.length - 1 ? end : group.end),
  );
}

function partition(
  edits: Map<CommentDeletion, FixEdit>,
  members: CommentDeletion[],
  start: number,
  end: number,
  text = "",
) {
  members.forEach((member, index) => {
    const last = index === members.length - 1;
    edits.set(member, {
      range: {
        start: index === 0 ? start : member.start,
        end: last ? end : members[index + 1]!.start,
      },
      text: last ? text : "",
    });
  });
}

function lineStartAt(source: string, offset: number): number {
  const start = source.lastIndexOf("\n", offset - 1) + 1;
  return start === 0 && source.startsWith("\uFEFF") ? 1 : start;
}

function lineEndAt(source: string, offset: number): number {
  const end = source.indexOf("\n", offset);
  return end === -1 ? source.length : end;
}

function nextLineStart(source: string, lineEnd: number): number {
  return lineEnd === source.length ? lineEnd : lineEnd + 1;
}
