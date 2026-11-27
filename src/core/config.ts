import { loadConfig } from "c12";
import { defu } from "defu";
import type {
  DoctorExtends,
  DoctorExtensionInput,
  DoctorFramework,
  DoctorSerializableConfig,
  ProjectInfo,
  RuntimeTarget,
} from "./primitives.js";
import type { McpServerTarget } from "../mcp/evidence.js";
export type {
  DoctorConfigOverride,
  DoctorRuleConfig,
  DoctorSerializableConfig,
} from "./primitives.js";

export interface DoctorConfig extends DoctorSerializableConfig {
  extensions?: DoctorExtensionInput[];
}

export interface DoctorRunOptions {
  root?: string;
  /** Already-loaded Doctor config. */
  config?: DoctorConfig;
  /** @internal Path of the automatically discovered JSON config, if loaded by the CLI. */
  declarativeConfigFile?: string;
  framework?: "auto" | DoctorFramework;
  extends?: DoctorExtends;
  changed?: boolean;
  since?: string;
  /**
   * Files whose Diagnostics this run reports, absolute or relative to `root`. Like `changed`, the
   * run analyzes the whole project so cross-file Rules keep their context, but it reports only
   * Diagnostics located in these files. Plugin Surfaces pass the files a dev server saw change.
   * Combined with `changed` or `since`, the report narrows to changed lines in these files.
   */
  affectedFiles?: string[];
  format?: import("./primitives.js").DoctorReportFormat;
  /**
   * Report Budget of text and agent reports in characters, 8,000 when unset. `Infinity` prints
   * the whole report. json and SARIF reports are always complete.
   */
  maxChars?: number;
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
   * Trust host code, such as `doctor:extendExtensions` registrations and Nitro's installed
   * auto-import scanner. CLI Surfaces only enable this through the host command or an explicit flag.
   */
  hostExtensions?: boolean;
  runtimeTarget?: RuntimeTarget;
  /**
   * MCP servers whose `tools/list` Vite Doctor reads as `mcp` Runtime Evidence. Headers can carry
   * tokens, so this stays out of Doctor config files.
   */
  mcp?: McpServerTarget[];
  /**
   * Inputs for Evidence Sources, keyed by source name. A source without an input is not read.
   * Inputs can carry tokens, so they stay out of Doctor config files.
   */
  sources?: Record<string, unknown>;
  /** `fetch` for Evidence Sources, `globalThis.fetch` when unset. */
  fetch?: typeof globalThis.fetch;
  /**
   * Project Inventory from `detectProject` for this root. The run reuses it instead of detecting
   * the project, so `framework` and `runtimeTarget` no longer apply. Doctor Extension inventory
   * and Runtime Evidence contributors still run.
   */
  project?: ProjectInfo;
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
