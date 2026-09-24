import { defineDiagnostics as defineNosticsDiagnostics, type DiagnosticHandle } from "nostics";
import { DOCTOR_DIAGNOSTICS_DOCS_BASE } from "./diagnostic-constants.js";
import { doctorInternalDiagnostics } from "./internal-diagnostic-handles.js";

export interface DoctorDiagnosticCodeEntry {
  code: string;
  ruleId: string;
  docs?: string | false;
}

export interface DoctorDiagnosticParams {
  why: string;
  fix: string;
  sources?: string[];
  cause?: unknown;
}

export type DoctorDiagnosticHandle = DiagnosticHandle<DoctorDiagnosticParams, {}>;

export type DoctorDiagnosticRegistry = {
  codesByRuleId: Record<string, string>;
  diagnostics: Readonly<Record<string, DoctorDiagnosticHandle>>;
};

export interface DoctorDiagnosticsHost {
  defineDiagnostics(entries: DoctorDiagnosticCodeEntry[]): DoctorDiagnosticRegistry;
  register(registry: DoctorDiagnosticRegistry): void;
  logger: Record<string, DoctorDiagnosticHandle>;
}

export function createDoctorDiagnosticsHost(): DoctorDiagnosticsHost {
  const logger: Record<string, DoctorDiagnosticHandle> = {};
  return {
    defineDiagnostics: defineDoctorDiagnostics,
    register(registry) {
      for (const [code, handle] of Object.entries(registry.diagnostics)) {
        if (logger[code]) throw doctorInternalDiagnostics.DOC0012({ code });
        logger[code] = handle;
      }
    },
    logger,
  };
}

export const doctorDiagnosticsHost = createDoctorDiagnosticsHost();
export const defineDiagnostics = defineDoctorDiagnostics;

export function codeForRuleId(
  codesByRuleId: Readonly<Partial<Record<string, string>>>,
  ruleId: string,
): string | undefined {
  return codesByRuleId[ruleId];
}

export function diagnosticForCode(
  diagnostics: Readonly<Partial<Record<string, DoctorDiagnosticHandle>>>,
  code: string | undefined,
): DoctorDiagnosticHandle | undefined {
  return code ? diagnostics[code] : undefined;
}

export function defineDoctorDiagnostics(
  entries: readonly DoctorDiagnosticCodeEntry[],
): DoctorDiagnosticRegistry {
  const codes: Record<
    string,
    {
      why: (params: DoctorDiagnosticParams) => string;
      fix: (params: DoctorDiagnosticParams) => string;
      docs?: string | false;
    }
  > = {};
  const codesByRuleId: Record<string, string> = {};
  for (const entry of entries) {
    const definition: {
      why: (params: DoctorDiagnosticParams) => string;
      fix: (params: DoctorDiagnosticParams) => string;
      docs?: string | false;
    } = {
      why: (params: DoctorDiagnosticParams) => params.why,
      fix: (params: DoctorDiagnosticParams) => params.fix,
    };
    if (entry.docs !== undefined) definition.docs = entry.docs;
    codes[entry.code] = definition;
    codesByRuleId[entry.ruleId] = entry.code;
  }
  return {
    codesByRuleId,
    diagnostics: defineNosticsDiagnostics({
      docsBase: (code) => `${DOCTOR_DIAGNOSTICS_DOCS_BASE}/${String(code)}`,
      codes,
    }),
  };
}
