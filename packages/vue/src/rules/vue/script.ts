import { parseSync } from "oxc-parser";

type ScriptParseLang = "js" | "jsx" | "ts" | "tsx";

export function parseScript(
  file: string,
  source: string,
  lang = langFromFile(file),
): Record<string, unknown> | null {
  try {
    const result = parseSync(file, source, {
      sourceType: "module",
      lang,
    } as any);
    return result.program as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
}

function langFromFile(file: string): ScriptParseLang {
  return file.endsWith(".tsx")
    ? "tsx"
    : file.endsWith(".jsx")
      ? "jsx"
      : file.endsWith(".ts") || file.endsWith(".vue")
        ? "ts"
        : "js";
}
