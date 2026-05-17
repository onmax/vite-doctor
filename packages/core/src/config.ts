import { loadConfig } from "c12";
import { defu } from "defu";
import type { DoctorExtension, DoctorFramework, DoctorSeverity } from "./primitives.js";

export type DoctorRuleConfig = "off" | DoctorSeverity | [DoctorSeverity, unknown];

export interface DoctorConfig {
  extends?: "auto" | string[];
  extensions?: DoctorExtension[];
  include?: string[];
  exclude?: string[];
  rules?: Record<string, DoctorRuleConfig>;
  suppressions?: Array<{ ruleId?: string; fingerprint?: string; file?: string; reason: string }>;
  typeAware?: boolean;
  cache?: { dir?: string; strategy?: "content-hash" };
  score?: { weights?: Partial<Record<"blocker" | "error" | "warn" | "info", number>> };
}

export interface DoctorRunOptions {
  root?: string;
  /** Already-loaded Doctor config. */
  config?: DoctorConfig;
  framework?: "auto" | DoctorFramework;
  extends?: "auto" | string[];
  changed?: boolean;
  since?: string;
  format?: string;
  baseline?: string;
  updateBaseline?: boolean;
  newOnly?: boolean;
  severity?: "error" | "warn" | "info";
  rules?: string;
  types?: boolean;
  threads?: number;
  coverage?: string;
  runtimeEvidence?: string;
  analyses?: string;
  emitGraph?: boolean;
  confidenceMin?: string;
  structuralReview?: boolean;
  profile?: boolean;
  cache?: boolean;
  fix?: boolean;
  unsafeFix?: boolean;
  scoreOnly?: boolean;
  maxWarnings?: number;
  extensions?: DoctorExtension[];
}

export function defineDoctorConfig(config: DoctorConfig): DoctorConfig {
  return config;
}

export interface LoadDoctorConfigOptions {
  cwd: string;
  defaults?: DoctorConfig;
}

export async function loadDoctorConfig(options: LoadDoctorConfigOptions): Promise<DoctorConfig> {
  const result = await loadConfig<DoctorConfig>({
    configFile: "doctor.config",
    cwd: options.cwd,
    dotenv: false,
    globalRc: false,
    name: "doctor",
  });
  return defu(result.config ?? {}, options.defaults ?? {}) as DoctorConfig;
}
