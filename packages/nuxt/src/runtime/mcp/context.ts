import { resolve } from "pathe";
import type { RulePack } from "@vue-doctor/core";

export interface NuxtDoctorMcpContext {
  rootDir: string;
  getRulePacks(): Promise<RulePack[]>;
}

const globalKey = "__NUXT_DOCTOR_MCP_CONTEXT__";

type NuxtDoctorGlobal = typeof globalThis & {
  [globalKey]?: NuxtDoctorMcpContext;
};

export function setNuxtDoctorMcpContext(context: NuxtDoctorMcpContext): void {
  (globalThis as NuxtDoctorGlobal)[globalKey] = context;
}

export function getNuxtDoctorMcpContext(): NuxtDoctorMcpContext {
  const existing = (globalThis as NuxtDoctorGlobal)[globalKey];
  if (existing) return existing;

  const runtimeConfig =
    typeof (globalThis as any).useRuntimeConfig === "function"
      ? (globalThis as any).useRuntimeConfig()
      : {};
  const rootDir = resolve(
    runtimeConfig.doctor?.rootDir ?? process.env.NUXT_DOCTOR_ROOT_DIR ?? process.cwd(),
  );
  return {
    rootDir,
    async getRulePacks() {
      return [];
    },
  };
}
