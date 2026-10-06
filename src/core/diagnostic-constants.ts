export const DOCTOR_DIAGNOSTICS_DOCS_BASE = "https://vite-doctor.onmax.me/diagnostics";

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
