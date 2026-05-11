import type { DoctorFramework, DoctorPlugin, DoctorSeverity } from "./primitives.js";

export type DoctorRuleConfig = "off" | DoctorSeverity | [DoctorSeverity, unknown];

export interface DoctorConfig {
  extends?: string[];
  plugins?: DoctorPlugin[];
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
  /**
   * Load executable doctor.config.* from the scan root.
   *
   * Keep this disabled for scans of repositories you do not fully trust.
   */
  config?: boolean;
  framework?: "auto" | DoctorFramework;
  preset?: string;
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
  plugins?: DoctorPlugin[];
}

export function defineDoctorConfig(config: DoctorConfig): DoctorConfig {
  return config;
}
