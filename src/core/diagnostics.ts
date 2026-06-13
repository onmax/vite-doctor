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

export type DoctorDiagnosticRegistry<
  Code extends string = string,
  RuleId extends string = string,
> = {
  codesByRuleId: Record<RuleId, Code>;
  diagnostics: { readonly [Key in Code]: DoctorDiagnosticHandle };
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

export function defineDoctorDiagnostics<const Entries extends readonly DoctorDiagnosticCodeEntry[]>(
  entries: Entries,
): DoctorDiagnosticRegistry<Entries[number]["code"], Entries[number]["ruleId"]> {
  type Code = Entries[number]["code"];
  type RuleId = Entries[number]["ruleId"];
  const codes = Object.fromEntries(
    entries.map((entry) => [
      entry.code,
      {
        why: (params: DoctorDiagnosticParams) => params.why,
        fix: (params: DoctorDiagnosticParams) => params.fix,
        ...(entry.docs === undefined ? {} : { docs: entry.docs }),
      },
    ]),
  ) as Record<
    Code,
    {
      why: (params: DoctorDiagnosticParams) => string;
      fix: (params: DoctorDiagnosticParams) => string;
      docs?: string | false;
    }
  >;
  return {
    codesByRuleId: Object.fromEntries(entries.map((entry) => [entry.ruleId, entry.code])) as Record<
      RuleId,
      Code
    >,
    diagnostics: defineNosticsDiagnostics({
      docsBase: (code) => `${DOCTOR_DIAGNOSTICS_DOCS_BASE}/${String(code)}`,
      codes,
    }) as unknown as { readonly [Key in Code]: DoctorDiagnosticHandle },
  };
}
