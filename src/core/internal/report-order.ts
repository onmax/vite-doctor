import type { Diagnostic } from "../primitives.js";

export const SEVERITIES = ["blocker", "error", "warn", "info"] as const;

export function reportGroupKey(diagnostic: Diagnostic): string {
  return `${diagnostic.severity}\0${diagnostic.code}\0${diagnostic.confidence ?? ""}`;
}

/** Diagnostics that share a severity, Diagnostic Code and confidence, in report order. */
export function reportOrder(diagnostics: readonly Diagnostic[]): Diagnostic[][] {
  const groups = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    const key = reportGroupKey(diagnostic);
    const group = groups.get(key);
    if (group) group.push(diagnostic);
    else groups.set(key, [diagnostic]);
  }
  return [...groups.values()].sort(
    ([a], [b]) =>
      SEVERITIES.indexOf(a!.severity) - SEVERITIES.indexOf(b!.severity) ||
      (a!.code < b!.code ? -1 : a!.code > b!.code ? 1 : 0),
  );
}
