import { parseSync } from "oxc-parser";

export type ScriptParseLang = "js" | "jsx" | "ts" | "tsx";

export function parseScript(
  file: string,
  source: string,
  lang = langFromFile(file),
): Record<string, unknown> | null {
  return parseScriptResult(file, source, lang).ast;
}

export function parseScriptResult(
  file: string,
  source: string,
  lang = langFromFile(file),
): { ast: Record<string, unknown> | null; errors: string[]; incomplete: boolean } {
  try {
    const result = parseSync(file, source, {
      sourceType: "module",
      lang,
    } as any);
    const errors = result.errors
      .filter((error) => error.severity === "Error")
      .map((error) => error.message);
    const incomplete =
      errors.length > 0 &&
      hasDiscardedSource(source, [
        ...result.program.body,
        ...result.comments,
        ...(result.program.hashbang ? [result.program.hashbang] : []),
      ]);
    return {
      ast: Object.assign(result.program, { comments: result.comments }) as unknown as Record<
        string,
        unknown
      >,
      errors,
      incomplete,
    };
  } catch (error) {
    return {
      ast: null,
      errors: [error instanceof Error ? error.message : String(error)],
      incomplete: true,
    };
  }
}

function hasDiscardedSource(source: string, ranges: { start: number; end: number }[]): boolean {
  // Recovered statements can coexist with discarded source; parser errors alone do not prove loss.
  ranges.sort((left, right) => left.start - right.start);
  let coveredUntil = 0;
  for (const range of ranges) {
    if (source.slice(coveredUntil, range.start).trim()) return true;
    coveredUntil = Math.max(coveredUntil, range.end);
  }
  return Boolean(source.slice(coveredUntil).trim());
}

export function langFromFile(file: string): ScriptParseLang {
  return file.endsWith(".tsx")
    ? "tsx"
    : file.endsWith(".jsx")
      ? "jsx"
      : file.endsWith(".ts") ||
          file.endsWith(".mts") ||
          file.endsWith(".cts") ||
          file.endsWith(".vue")
        ? "ts"
        : "js";
}
