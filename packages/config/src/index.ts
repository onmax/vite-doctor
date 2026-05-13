import { loadConfig } from "c12";
import { defu } from "defu";
import type { DoctorConfig } from "@vue-doctor/core";

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

export function defineDoctorConfig(config: DoctorConfig): DoctorConfig {
  return config;
}
