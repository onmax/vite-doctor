import {
  defineDoctorExtension,
  runDoctor,
  type DoctorExtension,
  type DoctorFramework,
  type DoctorRunOptions,
  type DoctorRunResult,
} from "@vue-doctor/core";
import { existsSync, readFileSync } from "node:fs";
import { join } from "pathe";
import { nitroRulePack } from "nitro-doctor";
import { nuxtDoctorExtensions, nuxtRulePacks } from "nuxt-doctor/rules";
import { vueRulePack } from "vue-doctor";
import { viteRulePack } from "./rules.js";

export async function viteDoctorRulePacks(options: DoctorRunOptions = {}) {
  const framework = detectRequestedFramework(options);
  const packs = [viteRulePack];
  if (framework === "vue") packs.push(vueRulePack);
  if (framework === "nitro") packs.push(nitroRulePack);
  if (framework === "nuxt") packs.push(...nuxtRulePacks());
  return packs;
}

export async function viteDoctorExtensions(
  options: DoctorRunOptions = {},
): Promise<DoctorExtension[]> {
  const framework = detectRequestedFramework(options);
  const extensions = [
    defineDoctorExtension({ name: "vite-doctor/builtin-vite", rulePacks: [viteRulePack] }),
  ];
  if (framework === "vue") {
    extensions.push(
      defineDoctorExtension({ name: "vite-doctor/builtin-vue", rulePacks: [vueRulePack] }),
    );
  }
  if (framework === "nitro") {
    extensions.push(
      defineDoctorExtension({ name: "vite-doctor/builtin-nitro", rulePacks: [nitroRulePack] }),
    );
  }
  if (framework === "nuxt") {
    extensions.push(...nuxtDoctorExtensions());
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

function detectRequestedFramework(options: DoctorRunOptions): DoctorFramework {
  if (
    options.framework === "vite" ||
    options.framework === "vue" ||
    options.framework === "nitro" ||
    options.framework === "nuxt"
  ) {
    return options.framework;
  }
  const root = options.root ?? process.cwd();
  const packageJson = readPackageJson(root);
  const deps = { ...packageJson?.dependencies, ...packageJson?.devDependencies };
  if (deps.nuxt || deps["@nuxt/kit"] || hasConfig(root, "nuxt.config")) return "nuxt";
  if (deps.nitro || deps.nitropack || hasConfig(root, "nitro.config")) return "nitro";
  if (deps.vue || hasVueFiles(root)) return "vue";
  return "vite";
}

function readPackageJson(root: string): {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} | null {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function hasConfig(root: string, basename: string) {
  return [".ts", ".mts", ".js", ".mjs", ".cjs"].some((ext) =>
    existsSync(join(root, basename + ext)),
  );
}

function hasVueFiles(root: string) {
  return existsSync(join(root, "src/App.vue")) || existsSync(join(root, "app.vue"));
}
