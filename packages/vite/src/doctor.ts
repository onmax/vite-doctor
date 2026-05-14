import {
  defineDoctorPlugin,
  runDoctor,
  type DoctorPlugin,
  type DoctorRunOptions,
  type DoctorRunResult,
  type RulePack,
} from "@vue-doctor/core";
import { consola } from "consola";
import { viteRulePack } from "./rules.js";

const optionalImport = <T>(specifier: string) => import(/* @vite-ignore */ specifier) as Promise<T>;

export async function viteDoctorRulePacks(options: DoctorRunOptions = {}) {
  const framework = detectRequestedFramework(options);
  const packs = [viteRulePack];
  if (framework === "vue") packs.push(...(await optionalVueRulePacks()));
  if (framework === "nuxt") packs.push(...(await optionalNuxtRulePacks()));
  return packs;
}

export async function viteDoctorPlugins(options: DoctorRunOptions = {}): Promise<DoctorPlugin[]> {
  const framework = detectRequestedFramework(options);
  const plugins = [
    defineDoctorPlugin({ name: "vite-doctor/builtin-vite", rulePacks: [viteRulePack] }),
  ];
  const vueRulePacks = framework === "vue" ? await optionalVueRulePacks() : [];
  if (vueRulePacks.length) {
    plugins.push(defineDoctorPlugin({ name: "vite-doctor/optional-vue", rulePacks: vueRulePacks }));
  }
  const nuxtPlugins = framework === "nuxt" ? await optionalNuxtPlugins() : [];
  if (nuxtPlugins.length) {
    plugins.push(...nuxtPlugins);
  }
  return plugins;
}

export async function runViteDoctor(options: DoctorRunOptions) {
  const framework = detectRequestedFramework(options);
  const plugins = await viteDoctorPlugins(options);
  return runDoctor({
    ...options,
    framework,
    plugins: [...plugins, ...(options.plugins ?? [])],
  });
}

export function shouldFailDoctorRun(result: DoctorRunResult, maxWarnings?: number) {
  return (
    result.summary.blocker > 0 ||
    result.summary.error > 0 ||
    (maxWarnings !== undefined && result.summary.warn > maxWarnings)
  );
}

async function optionalVueRulePacks(): Promise<RulePack[]> {
  try {
    const mod = await optionalImport<{ vueRulePack: RulePack }>("vue-doctor/rules");
    return [mod.vueRulePack];
  } catch (error) {
    try {
      const mod = await import("../../vue/src/rules.ts");
      return [mod.vueRulePack];
    } catch {
      reportMissingOptionalPack("vue-doctor", error);
      return [];
    }
  }
}

async function optionalNuxtRulePacks(): Promise<RulePack[]> {
  try {
    const mod = await optionalImport<{ nuxtRulePacks: () => RulePack[] }>("nuxt-doctor/rules");
    return mod.nuxtRulePacks();
  } catch (error) {
    try {
      const mod = await import("../../nuxt/src/rules/index.ts");
      return mod.nuxtRulePacks();
    } catch {
      reportMissingOptionalPack("nuxt-doctor", error);
      return [];
    }
  }
}

async function optionalNuxtPlugins(): Promise<DoctorPlugin[]> {
  try {
    const mod = await optionalImport<{ nuxtDoctorPlugins: () => DoctorPlugin[] }>(
      "nuxt-doctor/rules",
    );
    return mod.nuxtDoctorPlugins();
  } catch (error) {
    try {
      const mod = await import("../../nuxt/src/rules/index.ts");
      return mod.nuxtDoctorPlugins();
    } catch {
      reportMissingOptionalPack("nuxt-doctor", error);
      return [];
    }
  }
}

function reportMissingOptionalPack(pkg: string, error: unknown) {
  if (!isModuleNotFound(error)) throw error;
  consola.warn(`Optional ${pkg} rules are not installed. Install ${pkg} to enable those checks.`);
}

function isModuleNotFound(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === "ERR_MODULE_NOT_FOUND"
  );
}

function detectRequestedFramework(options: DoctorRunOptions): "vite" | "vue" | "nuxt" {
  if (options.framework === "vite" || options.framework === "vue" || options.framework === "nuxt") {
    return options.framework;
  }
  return "vite";
}
