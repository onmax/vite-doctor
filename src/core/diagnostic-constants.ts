export const DOCTOR_DIAGNOSTICS_DOCS_BASE = "https://vite-doctor.onmax.me/diagnostics";

// Bump whenever fingerprint inputs or occurrence numbering change, so baselines written with the
// previous scheme are reported instead of silently turning recorded findings into new ones.
// Baselines without a scheme predate occurrence-numbered duplicate fingerprints.
export const FINGERPRINT_SCHEME = 4;

export const RESERVED_DIAGNOSTIC_CODE_PREFIXES: readonly string[] = [
  "DOC",
  "DS",
  "H3",
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
 * Codes Doctor no longer reports, kept so no new Rule reuses them. Each maps to the Rule that
 * reported it and to where its check lives now: loadsheet reads a running MCP server, and Doctor
 * reads only source.
 */
export const RETIRED_DIAGNOSTIC_CODES: Readonly<
  Record<string, { ruleId: string; movedTo: string }>
> = Object.fromEntries(
  (
    [
      ["MCP0005", "mcp/clients/no-excluded-tool"],
      ["MCP0006", "mcp/clients/no-truncated-text"],
      ["MCP0007", "mcp/clients/no-rewritten-schema"],
      ["MCP0008", "mcp/clients/no-stripped-constraint"],
      ["MCP0009", "mcp/clients/no-reduced-context"],
      ["MCP0010", "mcp/tools/valid-annotations"],
    ] as const
  ).map(([code, ruleId]) => [
    code,
    { ruleId, movedTo: `https://loadsheet.dev/docs/reference/mcp#${code.toLowerCase()}` },
  ]),
);

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

const DIAGNOSTIC_CODE_PATTERN = /^([A-Z][A-Z0-9]*?)(\d{4})$/;

export function diagnosticCodePrefix(code: string): string | undefined {
  return DIAGNOSTIC_CODE_PATTERN.exec(code)?.[1];
}

export function isReservedDiagnosticCode(code: string): boolean {
  const prefix = diagnosticCodePrefix(code);
  return prefix !== undefined && RESERVED_DIAGNOSTIC_CODE_PREFIXES.includes(prefix);
}
