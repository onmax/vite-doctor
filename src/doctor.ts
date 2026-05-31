import {
  defineDoctorExtension,
  runDoctor,
  type DoctorExtension,
  type DoctorFramework,
  type DoctorRunOptions,
  type DoctorRunResult,
} from "./core/index.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "pathe";
import { nitroRulePack } from "./rule-packs/nitro/index.js";
import { nuxtDoctorExtensions, nuxtRulePacks } from "./rule-packs/nuxt/rules/index.js";
import { vueRulePack } from "./rule-packs/vue/rules.js";
import { viteRulePack } from "./rules.js";
import { viteDoctorVersion } from "./version.js";

export async function viteDoctorRulePacks(options: DoctorRunOptions = {}) {
  const framework = detectRequestedFramework(options);
  const packs = [viteRulePack];
  if (framework === "vue") packs.push(vueRulePack);
  if (framework === "nitro") packs.push(nitroRulePack);
  if (framework === "nuxt") packs.push(...nuxtRulePacks());
  return packs.map(withDistributionVersion);
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
  return extensions.map((extension) => ({
    ...extension,
    version: extension.version ?? viteDoctorVersion,
    rulePacks: extension.rulePacks?.map(withDistributionVersion),
  }));
}

export async function runViteDoctor(options: DoctorRunOptions) {
  const framework = detectRequestedFramework(options);
  const extensions = await viteDoctorExtensions(options);
  const result = await runDoctor({
    ...options,
    config: {
      ...options.config,
      cache:
        framework === "nuxt"
          ? { dir: ".nuxt/doctor/cache", ...options.config?.cache }
          : options.config?.cache,
    },
    framework,
    extensions: [...extensions, ...(options.extensions ?? [])],
  });
  return { ...result, version: viteDoctorVersion };
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

function withDistributionVersion<T extends { version: string }>(item: T): T {
  return { ...item, version: viteDoctorVersion };
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
