import {
  defineDoctorExtension,
  runDoctor,
  type DoctorExtension,
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

export async function viteDoctorExtensions(
  options: DoctorRunOptions = {},
): Promise<DoctorExtension[]> {
  const framework = detectRequestedFramework(options);
  const extensions = [
    defineDoctorExtension({ name: "vite-doctor/builtin-vite", rulePacks: [viteRulePack] }),
  ];
  const vueRulePacks = framework === "vue" ? await optionalVueRulePacks() : [];
  if (vueRulePacks.length) {
    extensions.push(
      defineDoctorExtension({ name: "vite-doctor/optional-vue", rulePacks: vueRulePacks }),
    );
  }
  const nuxtExtensions = framework === "nuxt" ? await optionalNuxtExtensions() : [];
  if (nuxtExtensions.length) {
    extensions.push(...nuxtExtensions);
  }
  return extensions;
}

export async function runViteDoctor(options: DoctorRunOptions) {
  const framework = detectRequestedFramework(options);
  const extensions = await viteDoctorExtensions(options);
  return runDoctor({
    ...options,
    framework,
    extensions: [...extensions, ...(options.extensions ?? [])],
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

async function optionalNuxtExtensions(): Promise<DoctorExtension[]> {
  try {
    const mod = await optionalImport<{ nuxtDoctorExtensions: () => DoctorExtension[] }>(
      "nuxt-doctor/rules",
    );
    return mod.nuxtDoctorExtensions();
  } catch (error) {
    try {
      const mod = await import("../../nuxt/src/rules/index.ts");
      return mod.nuxtDoctorExtensions();
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
