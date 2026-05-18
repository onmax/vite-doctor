import { defineDiagnostics as defineNosticsDiagnostics, type DiagnosticHandle } from "nostics";
import { DOCTOR_DIAGNOSTICS_DOCS_BASE } from "./primitives.js";

export interface DoctorDiagnosticCodeEntry {
  code: string;
  ruleId: string;
}

export interface DoctorDiagnosticParams {
  why: string;
  fix: string;
  sources?: string[];
  cause?: unknown;
}

export interface DoctorDiagnosticRegistry {
  codesByRuleId: Record<string, string>;
  diagnostics: Record<string, DiagnosticHandle<DoctorDiagnosticParams, {}>>;
}

export interface DoctorDiagnosticsHost {
  defineDiagnostics(entries: DoctorDiagnosticCodeEntry[]): DoctorDiagnosticRegistry;
  register(registry: DoctorDiagnosticRegistry): void;
  logger: Record<string, DiagnosticHandle<DoctorDiagnosticParams, {}>>;
}

export function createDoctorDiagnosticsHost(): DoctorDiagnosticsHost {
  const logger: Record<string, DiagnosticHandle<DoctorDiagnosticParams, {}>> = {};
  return {
    defineDiagnostics: defineDoctorDiagnostics,
    register(registry) {
      for (const [code, handle] of Object.entries(registry.diagnostics)) {
        if (logger[code]) throw new Error(`Duplicate Doctor diagnostic code: ${code}`);
        logger[code] = handle;
      }
    },
    logger,
  };
}

export const doctorDiagnosticsHost = createDoctorDiagnosticsHost();
export const defineDiagnostics = defineDoctorDiagnostics;

export function defineDoctorDiagnostics(
  entries: DoctorDiagnosticCodeEntry[],
): DoctorDiagnosticRegistry {
  const codes = Object.fromEntries(
    entries.map((entry) => [
      entry.code,
      {
        why: (params: DoctorDiagnosticParams) => params.why,
        fix: (params: DoctorDiagnosticParams) => params.fix,
      },
    ]),
  );
  return {
    codesByRuleId: Object.fromEntries(entries.map((entry) => [entry.ruleId, entry.code])),
    diagnostics: defineNosticsDiagnostics({
      docsBase: (code) => `${DOCTOR_DIAGNOSTICS_DOCS_BASE}/${String(code)}`,
      codes,
    }) as Record<string, DiagnosticHandle<DoctorDiagnosticParams, {}>>,
  };
}
