export const DOCTOR_DIAGNOSTICS_DOCS_BASE = "https://vite-doctor.onmax.me/diagnostics";

// Bump whenever fingerprint inputs or occurrence numbering change, so baselines written with the
// previous scheme are reported instead of silently turning recorded findings into new ones.
// Baselines without a scheme predate occurrence-numbered duplicate fingerprints.
export const FINGERPRINT_SCHEME = 2;

export const RESERVED_DIAGNOSTIC_CODE_PREFIXES: readonly string[] = [
  "DOC",
  "NITRO",
  "NUXT",
  "PINIA",
  "PKG",
  "SHAD",
  "TS",
  "VITE",
  "VUE",
];

const DIAGNOSTIC_CODE_PATTERN = /^([A-Z]+)(\d{4})$/;

export function diagnosticCodePrefix(code: string): string | undefined {
  return DIAGNOSTIC_CODE_PATTERN.exec(code)?.[1];
}

export function isReservedDiagnosticCode(code: string): boolean {
  const prefix = diagnosticCodePrefix(code);
  return prefix !== undefined && RESERVED_DIAGNOSTIC_CODE_PREFIXES.includes(prefix);
}
