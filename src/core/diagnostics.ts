import { defineDiagnostics as defineNosticsDiagnostics, type DiagnosticHandle } from "nostics";
import {
  DOCTOR_DIAGNOSTICS_DOCS_BASE,
  diagnosticCodePrefix,
  isReservedDiagnosticCode,
} from "./diagnostic-constants.js";
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

export interface DefineDoctorDiagnosticsOptions {
  /**
   * Diagnostic Reference base for these codes. A string resolves to `${docsBase}/${code}`.
   * Built-in Doctor prefixes default to the Doctor Diagnostic Reference; other prefixes
   * have no docs URL unless this option or a per-entry `docs` string provides one.
   */
  docsBase?: string | ((code: string) => string | undefined);
}

export type DoctorDiagnosticRegistry<
  Code extends string = string,
  RuleId extends string = string,
> = {
  codesByRuleId: Record<RuleId, Code>;
  codesByRuleIdAll: Record<RuleId, readonly Code[]>;
  docsByCode: { readonly [Key in Code]: string | undefined };
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
  options: DefineDoctorDiagnosticsOptions = {},
): DoctorDiagnosticRegistry<Entries[number]["code"], Entries[number]["ruleId"]> {
  type Code = Entries[number]["code"];
  type RuleId = Entries[number]["ruleId"];
  const seenCodes = new Set<string>();
  for (const entry of entries) {
    if (seenCodes.has(entry.code)) throw doctorInternalDiagnostics.DOC0012({ code: entry.code });
    seenCodes.add(entry.code);
  }
  const docsByCode = Object.fromEntries(
    entries.map((entry) => [entry.code, diagnosticDocsUrl(entry, options.docsBase)]),
  ) as Record<Code, string | undefined>;
  const codes = Object.fromEntries(
    entries.map((entry) => [
      entry.code,
      {
        why: (params: DoctorDiagnosticParams) => params.why,
        fix: (params: DoctorDiagnosticParams) => params.fix,
        docs: docsByCode[entry.code as Code] ?? false,
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
  const codesByRuleIdAll = new Map<string, string[]>();
  for (const entry of entries) {
    const codes = codesByRuleIdAll.get(entry.ruleId) ?? [];
    codes.push(entry.code);
    codesByRuleIdAll.set(entry.ruleId, codes);
  }
  return {
    codesByRuleId: Object.fromEntries(entries.map((entry) => [entry.ruleId, entry.code])) as Record<
      RuleId,
      Code
    >,
    codesByRuleIdAll: Object.fromEntries(
      [...codesByRuleIdAll].map(([ruleId, codes]) => [ruleId, codes]),
    ) as unknown as Record<RuleId, readonly Code[]>,
    docsByCode,
    diagnostics: defineNosticsDiagnostics({ codes }) as unknown as {
      readonly [Key in Code]: DoctorDiagnosticHandle;
    },
  };
}

/** Public variant for Doctor Extensions: codes must use a package-owned, non-reserved prefix. */
export function defineExtensionDiagnostics<
  const Entries extends readonly DoctorDiagnosticCodeEntry[],
>(
  entries: Entries,
  options: DefineDoctorDiagnosticsOptions = {},
): DoctorDiagnosticRegistry<Entries[number]["code"], Entries[number]["ruleId"]> {
  for (const entry of entries) assertExtensionDiagnosticCode(entry.code, "defineDoctorDiagnostics");
  return defineDoctorDiagnostics(entries, options);
}

export function assertExtensionDiagnosticCode(code: string, owner: string): void {
  const prefix = diagnosticCodePrefix(code);
  if (!prefix) throw doctorInternalDiagnostics.DOC0027({ code, owner });
  if (isReservedDiagnosticCode(code)) {
    throw doctorInternalDiagnostics.DOC0028({ code, owner, prefix });
  }
}

function diagnosticDocsUrl(
  entry: DoctorDiagnosticCodeEntry,
  docsBase: DefineDoctorDiagnosticsOptions["docsBase"],
): string | undefined {
  if (entry.docs === false) return undefined;
  if (entry.docs) return entry.docs;
  if (typeof docsBase === "string") return `${docsBase.replace(/\/+$/, "")}/${entry.code}`;
  if (docsBase) return docsBase(entry.code);
  return isReservedDiagnosticCode(entry.code)
    ? `${DOCTOR_DIAGNOSTICS_DOCS_BASE}/${entry.code}`
    : undefined;
}
