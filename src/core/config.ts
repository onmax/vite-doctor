import { loadConfig } from "c12";
import { defu } from "defu";
import type {
  DoctorExtensionInput,
  DoctorFramework,
  DoctorSerializableConfig,
  RuntimeTarget,
} from "./primitives.js";
export type { DoctorRuleConfig, DoctorSerializableConfig } from "./primitives.js";

export interface DoctorConfig extends DoctorSerializableConfig {
  extensions?: DoctorExtensionInput[];
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
  analyses?: string;
  structuralReview?: boolean;
  profile?: boolean;
  cache?: boolean;
  fix?: boolean;
  unsafeFix?: boolean;
  maxWarnings?: number;
  extensions?: DoctorExtensionInput[];
  /**
   * Load Doctor Extension entries that host integrations recorded in their Project Inventory,
   * such as `doctor:extendExtensions` registrations in the Nuxt manifest. This executes code
   * registered by the host, so CLI Surfaces only enable it through the host command or an
   * explicit flag.
   */
  hostExtensions?: boolean;
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
