import { isAstNode } from "./ast-node.js";

export async function parseTemplate(
  file: string,
  source: string,
): Promise<Record<string, unknown> | null> {
  try {
    const [{ parseForESLint }, tsParser] = await Promise.all([
      import("vue-eslint-parser"),
      import("@typescript-eslint/parser"),
    ]);
    const result = parseForESLint(source, {
      filePath: file,
      sourceType: "module",
      ecmaVersion: "latest",
      parserOptions: {
        parser: tsParser,
      },
    });
    return isAstNode(result.ast.templateBody) ? result.ast.templateBody : null;
  } catch {
    return null;
  }
}
