const optionalImport = <T>(specifier: string) => import(/* @vite-ignore */ specifier) as Promise<T>;

export async function parseTemplate(
  file: string,
  source: string,
): Promise<Record<string, unknown> | null> {
  try {
    const [{ parseForESLint }, tsParser] = await Promise.all([
      optionalImport<typeof import("vue-eslint-parser")>("vue-eslint-parser"),
      optionalImport<typeof import("@typescript-eslint/parser")>("@typescript-eslint/parser"),
    ]);
    const parser = defaultExport(tsParser);
    const result = parseForESLint(source, {
      filePath: file,
      sourceType: "module",
      ecmaVersion: "latest",
      parserOptions: {
        parser: parser as any,
      },
    });
    return (result.ast.templateBody as unknown as Record<string, unknown>) ?? null;
  } catch {
    return null;
  }
}

function defaultExport<T>(mod: T): T {
  return ((mod as { default?: T }).default ?? mod) as T;
}
