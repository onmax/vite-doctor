import {
  defineDoctorExtension,
  cleanCache,
  detectProject,
  runDoctor,
  type DoctorConfig,
  type DoctorExtension,
  type DoctorFramework,
  type DoctorRunOptions,
  type DoctorRunResult,
  type NuxtDoctorManifest,
} from "./core/index.js";
import { collectRulePacks, resolveProjectDoctorConfig } from "./core/internal/scan-session.js";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isAbsolute, join } from "pathe";
import { doctorInternalDiagnostics } from "./core/internal-diagnostic-handles.js";
import { viteRulePack } from "./rules.js";
import { typescriptRulePack } from "./rule-packs/typescript/index.js";
import shadcnRulePack from "./rule-packs/shadcn/index.js";
import { packageRulePack } from "./rule-packs/package/index.js";
import { piniaRulePack } from "./rule-packs/pinia/index.js";
import { viteDoctorVersion } from "./version.js";

export async function viteDoctorRulePacks(options: DoctorRunOptions = {}) {
  const registry = await collectRulePacks([
    ...(options.config?.extensions ?? []),
    ...(await viteDoctorExtensions(options)),
    ...(options.extensions ?? []),
    ...(await hostDoctorExtensions(options)),
  ]);
  return registry.packs;
}

export async function viteDoctorExtensions(
  options: DoctorRunOptions = {},
): Promise<DoctorExtension[]> {
  const framework = detectRequestedFramework(options);
  const extensions = [
    defineDoctorExtension({ name: "vite-doctor/builtin-package", rulePacks: [packageRulePack] }),
    defineDoctorExtension({ name: "vite-doctor/builtin-vite", rulePacks: [viteRulePack] }),
    defineDoctorExtension({
      name: "vite-doctor/builtin-typescript",
      rulePacks: [typescriptRulePack],
    }),
    defineDoctorExtension({ name: "vite-doctor/builtin-shadcn", rulePacks: [shadcnRulePack] }),
    defineDoctorExtension({ name: "vite-doctor/builtin-pinia", rulePacks: [piniaRulePack] }),
  ];
  if (framework === "vue") {
    const { vueRulePack } = await import("./rule-packs/vue/rules.js");
    extensions.push(
      defineDoctorExtension({ name: "vite-doctor/builtin-vue", rulePacks: [vueRulePack] }),
    );
  }
  if (framework === "nitro") {
    const { nitroRulePack } = await import("./rule-packs/nitro/index.js");
    extensions.push(
      defineDoctorExtension({ name: "vite-doctor/builtin-nitro", rulePacks: [nitroRulePack] }),
    );
  }
  if (framework === "nuxt") {
    const { nuxtDoctorExtensions } = await import("./rule-packs/nuxt/rules/index.js");
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
    framework,
    extensions: [
      ...extensions,
      ...(options.extensions ?? []),
      ...(await hostDoctorExtensions(options)),
    ],
  });
  return { ...result, version: viteDoctorVersion };
}

export async function hostDoctorExtensions(
  options: DoctorRunOptions = {},
): Promise<DoctorExtension[]> {
  if (!options.hostExtensions || detectRequestedFramework(options) !== "nuxt") return [];
  const root = options.root ?? process.cwd();
  const manifest = readJson<Pick<NuxtDoctorManifest, "extensions">>(
    join(root, ".nuxt/doctor.manifest.json"),
  );
  return Promise.all((manifest?.extensions ?? []).map(loadHostExtensionEntry));
}

async function loadHostExtensionEntry(entry: string): Promise<DoctorExtension> {
  if (!isAbsolute(entry)) {
    throw doctorInternalDiagnostics.DOC0029({
      entry,
      reason: "host inventory must record an absolute module path.",
    });
  }
  let module: { default?: unknown };
  try {
    module = await import(pathToFileURL(entry).href);
  } catch (error) {
    throw doctorInternalDiagnostics.DOC0029({
      entry,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  const extension = module.default as Partial<DoctorExtension> | undefined;
  if (!extension || typeof extension !== "object" || typeof extension.name !== "string") {
    throw doctorInternalDiagnostics.DOC0029({
      entry,
      reason: "the default export is not a Doctor Extension.",
    });
  }
  return extension as DoctorExtension;
}

export async function cleanViteDoctorCache(
  root: string,
  config?: DoctorConfig,
  requestedFramework?: DoctorFramework,
): Promise<void> {
  const framework = detectRequestedFramework({ root, config, framework: requestedFramework });
  const project = await detectProject(root, framework);
  cleanCache(root, resolveProjectDoctorConfig(project, config));
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
  const deps = {
    ...packageJson?.dependencies,
    ...packageJson?.optionalDependencies,
    ...packageJson?.devDependencies,
  };
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
  optionalDependencies?: Record<string, string>;
} | null {
  return readJson(join(root, "package.json"));
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
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
