export const DOCTOR_DIAGNOSTICS_DOCS_BASE = "https://vite-doctor.onmax.me/diagnostics";

// Bump whenever fingerprint inputs or occurrence numbering change, so baselines written with the
// previous scheme are reported instead of silently turning recorded findings into new ones.
// Baselines without a scheme predate occurrence-numbered duplicate fingerprints.
export const FINGERPRINT_SCHEME = 3;

export const RESERVED_DIAGNOSTIC_CODE_PREFIXES: readonly string[] = [
  "DOC",
  "DS",
  "MCP",
  "NITRO",
  "NUXT",
  "PINIA",
  "PKG",
  "TS",
  "VITE",
  "VUE",
];

/**
 * Diagnostics whose one cause shows up at several related sites, such as an import cycle or state
 * written from many places. Each one's `fix` names the single fix and the mechanical move that only
 * hides the cause; tests/core/structural-fix-guidance.test.ts checks that for every code listed here.
 */
export const STRUCTURAL_DIAGNOSTIC_CODES: readonly string[] = [
  "DOC0001",
  "NUXT0097",
  "PINIA0003",
  "VITE0029",
  "VUE0048",
];

const DIAGNOSTIC_CODE_PATTERN = /^([A-Z]+)(\d{4})$/;

export function diagnosticCodePrefix(code: string): string | undefined {
  return DIAGNOSTIC_CODE_PATTERN.exec(code)?.[1];
}

export function isReservedDiagnosticCode(code: string): boolean {
  const prefix = diagnosticCodePrefix(code);
  return prefix !== undefined && RESERVED_DIAGNOSTIC_CODE_PREFIXES.includes(prefix);
}
