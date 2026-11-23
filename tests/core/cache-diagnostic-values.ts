import type { Diagnostic } from "../../src/core/primitives.ts";

export function cacheDiagnosticValues(diagnostics: readonly Diagnostic[]): unknown {
  return JSON.parse(
    JSON.stringify(
      diagnostics.map((item) => ({
        ...item,
        diagnostic: Object.fromEntries(Object.entries(item.diagnostic)),
      })),
    ),
  );
}
