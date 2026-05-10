import { parseForESLint } from "vue-eslint-parser";
import tsParser from "@typescript-eslint/parser";

export function parseTemplate(file: string, source: string): Record<string, unknown> | null {
  try {
    const result = parseForESLint(source, {
      filePath: file,
      sourceType: "module",
      ecmaVersion: "latest",
      parserOptions: {
        parser: tsParser as any,
      },
    });
    return (result.ast.templateBody as unknown as Record<string, unknown>) ?? null;
  } catch {
    return null;
  }
}
