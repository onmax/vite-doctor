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
): { ast: Record<string, unknown> | null; errors: string[] } {
  try {
    const result = parseSync(file, source, {
      sourceType: "module",
      lang,
    } as any);
    return {
      ast: Object.assign(result.program, { comments: result.comments }) as unknown as Record<
        string,
        unknown
      >,
      errors: result.errors
        .filter((error) => error.severity === "Error")
        .map((error) => error.message),
    };
  } catch (error) {
    return { ast: null, errors: [error instanceof Error ? error.message : String(error)] };
  }
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
