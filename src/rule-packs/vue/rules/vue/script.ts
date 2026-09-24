import { parseSync } from "oxc-parser";
import { isAstNode } from "../../../../core/internal/ast-node.js";

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
    });
    return isAstNode(result.program) ? result.program : null;
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
