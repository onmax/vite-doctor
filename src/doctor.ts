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
import {
  detectWorkspacePackages,
  nuxtInventoryOwner,
  workspaceFramework,
} from "./core/internal/workspace-packages.js";
import { readFileSync } from "node:fs";
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
  const { frameworks } = await requestedFrameworks(options);
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
  if (frameworks.has("nuxt")) {
    const { nuxtDoctorExtensions } = await import("./rule-packs/nuxt/rules/index.js");
    extensions.push(...nuxtDoctorExtensions());
  } else {
    if (frameworks.has("vue")) {
      const { vueRulePack } = await import("./rule-packs/vue/rules.js");
      extensions.push(
        defineDoctorExtension({ name: "vite-doctor/builtin-vue", rulePacks: [vueRulePack] }),
      );
    }
    if (frameworks.has("nitro")) {
      const { nitroRulePack } = await import("./rule-packs/nitro/index.js");
      extensions.push(
        defineDoctorExtension({ name: "vite-doctor/builtin-nitro", rulePacks: [nitroRulePack] }),
      );
    }
  }
  return extensions.map((extension) => ({
    ...extension,
    version: extension.version ?? viteDoctorVersion,
    rulePacks: extension.rulePacks?.map(withDistributionVersion),
  }));
}

export async function runViteDoctor(options: DoctorRunOptions) {
  const extensions = await viteDoctorExtensions(options);
  const result = await runDoctor({
    ...options,
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
  if (!options.hostExtensions || (await requestedFrameworks(options)).framework !== "nuxt") {
    return [];
  }
  const root = options.root ?? process.cwd();
  const packages = await detectWorkspacePackages(root);
  const owner = nuxtInventoryOwner(packages)?.root ?? ".";
  const nuxtRoots = [
    owner,
    ...packages
      .filter((item) => item.framework === "nuxt" && item.root !== owner)
      .map((item) => item.root),
  ];
  const entries = new Set(
    nuxtRoots.flatMap(
      (packageRoot) =>
        readJson<Pick<NuxtDoctorManifest, "extensions">>(
          join(root, packageRoot, ".nuxt/doctor.manifest.json"),
        )?.extensions ?? [],
    ),
  );
  return Promise.all([...entries].map(loadHostExtensionEntry));
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
  const project = await detectProject(root, requestedFramework ?? "auto");
  cleanCache(root, resolveProjectDoctorConfig(project, config));
}

export function shouldFailDoctorRun(result: DoctorRunResult, maxWarnings?: number) {
  return (
    result.summary.blocker > 0 ||
    result.summary.error > 0 ||
    (maxWarnings !== undefined && result.summary.warn > maxWarnings)
  );
}

/**
 * An explicit framework selects exactly its Rule Packs. Otherwise every workspace package
 * contributes its framework, and Activation scopes each Rule Pack to the packages that need it.
 */
async function requestedFrameworks(
  options: DoctorRunOptions,
): Promise<{ framework: DoctorFramework; frameworks: Set<DoctorFramework> }> {
  if (options.framework && options.framework !== "auto") {
    return { framework: options.framework, frameworks: new Set([options.framework]) };
  }
  const packages = await detectWorkspacePackages(options.root ?? process.cwd());
  return {
    framework: workspaceFramework(packages),
    frameworks: new Set(packages.map((item) => item.framework)),
  };
}

function withDistributionVersion<T extends { version: string }>(item: T): T {
  return { ...item, version: viteDoctorVersion };
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}
