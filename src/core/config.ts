import { loadConfig } from "c12";
import { defu } from "defu";
import type {
  DoctorExtension,
  DoctorFramework,
  DoctorSerializableConfig,
  RuntimeTarget,
} from "./primitives.js";
export type { DoctorRuleConfig, DoctorSerializableConfig } from "./primitives.js";

export interface DoctorConfig extends DoctorSerializableConfig {
  extensions?: DoctorExtension[];
}

export interface DoctorRunOptions {
  root?: string;
  /** Already-loaded Doctor config. */
  config?: DoctorConfig;
  framework?: "auto" | DoctorFramework;
  extends?: "auto" | string[];
  changed?: boolean;
  since?: string;
  format?: import("./primitives.js").DoctorReportFormat;
  baseline?: string;
  updateBaseline?: boolean;
  newOnly?: boolean;
  severity?: "error" | "warn" | "info";
  rules?: string;
  types?: boolean;
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
  runtimeTarget?: RuntimeTarget;
}

export function defineDoctorConfig(config: DoctorConfig): DoctorConfig {
  return config;
}

export interface LoadDoctorConfigOptions {
  cwd: string;
  defaults?: DoctorConfig;
  configFile?: string;
}

export async function loadDoctorConfig(options: LoadDoctorConfigOptions): Promise<DoctorConfig> {
  const result = await loadConfig<DoctorConfig>({
    configFile: options.configFile ?? "doctor.config",
    configFileRequired: Boolean(options.configFile),
    cwd: options.cwd,
    dotenv: false,
    globalRc: false,
    extend: false,
    name: "doctor",
  });
  return defu(result.config ?? {}, options.defaults ?? {}) as DoctorConfig;
}
