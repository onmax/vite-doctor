import { existsSync, readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { join, resolve } from "pathe";
import type {
  AutoImportEntry,
  DoctorFramework,
  NuxtDoctorManifest,
  NuxtProjectInfo,
  ProjectInfo,
  ProjectLanguage,
} from "../primitives.js";
import { createNuxtProjectInventory, normalizeNuxtModuleSources } from "./nuxt-inventory.js";
import type { RuntimeTarget } from "../primitives.js";
import {
  applyRuntimeTarget,
  isNuxtManifestCurrent,
  resolveNuxtCompatibility,
  resolveRuntimeGraph,
} from "./runtime-graph.js";

export async function detectProject(
  root: string,
  requested: "auto" | DoctorFramework = "auto",
  runtimeTarget?: RuntimeTarget,
): Promise<ProjectInfo> {
  const packageJson = readJson<{
    name?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>(join(root, "package.json"));
  const deps = { ...packageJson?.dependencies, ...packageJson?.devDependencies };
  const nuxtVersion = deps.nuxt ?? deps["@nuxt/kit"];
  const viteVersion = deps.vite;
  const nitroVersion = deps.nitro ?? deps["nitropack"];
  const hasVue = Boolean(deps.vue);
  const vueVersion = deps.vue ?? ">=3.5";
  const framework: DoctorFramework =
    requested === "auto"
      ? nuxtVersion
        ? "nuxt"
        : nitroVersion
          ? "nitro"
          : hasVue
            ? "vue"
            : viteVersion
              ? "vite"
              : "vue"
      : requested;
  const ssr = framework === "nuxt" || framework === "nitro" || hasVueSsrEvidence(packageJson, deps);
  const isMonorepo =
    existsSync(join(root, "pnpm-workspace.yaml")) || existsSync(join(root, "turbo.json"));
  const nuxt =
    framework === "nuxt" ? await detectNuxt(root, nuxtVersion ?? ">=4", deps) : undefined;
  const detectedGraph = resolveRuntimeGraph(root, framework);
  const manifest =
    framework === "nuxt"
      ? readJson<NuxtDoctorManifest>(join(root, ".nuxt/doctor.manifest.json"))
      : null;
  const targeted = applyRuntimeTarget(
    detectedGraph,
    framework === "nuxt" ? resolveNuxtCompatibility(root, detectedGraph, manifest) : undefined,
    runtimeTarget,
  );
  const resolvedNuxtVersion = targeted.graph.packages.nuxt?.version;
  const resolvedVueVersion = targeted.graph.packages.vue?.version;
  const tsconfigPath = existsSync(join(root, "tsconfig.json"))
    ? join(root, "tsconfig.json")
    : undefined;
  return {
    root: resolve(root),
    framework,
    ssr,
    vueVersion: resolvedVueVersion ?? cleanVersion(vueVersion),
    nuxtVersion: nuxt
      ? (resolvedNuxtVersion ?? cleanVersion(nuxtVersion ?? nuxt.version))
      : undefined,
    isMonorepo,
    packageName: packageJson?.name,
    tsconfigPath,
    languages: await detectProjectLanguages(root, Boolean(tsconfigPath)),
    nuxt,
    runtimeGraph: targeted.graph,
    nuxtCompatibility: targeted.compatibility,
  };
}

async function detectProjectLanguages(
  root: string,
  hasTsconfig: boolean,
): Promise<ProjectLanguage[]> {
  let hasTypeScript = hasTsconfig;
  let hasJavaScript = false;
  for await (const entry of glob("**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}", {
    cwd: root,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.nuxt/**",
      "**/.next/**",
      "**/.output/**",
      "**/coverage/**",
      "**/generated/**",
    ],
  })) {
    if (typeof entry !== "string") continue;
    if (/\.(?:ts|tsx|mts|cts)$/.test(entry)) hasTypeScript = true;
    if (/\.(?:js|jsx|mjs|cjs)$/.test(entry)) hasJavaScript = true;
    if (hasTypeScript && hasJavaScript) break;
  }
  return [
    ...(hasTypeScript ? (["typescript"] as const) : []),
    ...(hasJavaScript ? (["javascript"] as const) : []),
  ];
}

function hasVueSsrEvidence(
  packageJson: { scripts?: Record<string, string> } | null,
  deps: Record<string, string | undefined>,
): boolean {
  const packageNames = Object.keys(deps);
  if (
    packageNames.some((name) =>
      /^(vitepress|vuepress|@vuepress\/|@vue\/server-renderer|vite-ssg|vite-plugin-ssr|vike|nuxt)$/.test(
        name,
      ),
    )
  )
    return true;
  return Object.values(packageJson?.scripts ?? {}).some((script) =>
    /\b(vitepress|vuepress|vite-ssg|vike|vite\s+build\s+--ssr)\b/.test(script),
  );
}

async function detectNuxt(
  root: string,
  version: string,
  deps: Record<string, string | undefined>,
): Promise<NuxtProjectInfo> {
  const manifestPath = join(root, ".nuxt/doctor.manifest.json");
  if (existsSync(manifestPath)) {
    return normalizeNuxtProject(
      root,
      version,
      deps,
      readJson<NuxtDoctorManifest>(manifestPath),
      manifestPath,
    );
  }
  return normalizeNuxtProject(root, version, deps, null);
}

async function normalizeNuxtProject(
  root: string,
  version: string,
  deps: Record<string, string | undefined>,
  manifest: NuxtDoctorManifest | null,
  manifestPath?: string,
): Promise<NuxtProjectInfo> {
  return {
    version: cleanVersion(manifest?.nuxtVersion ?? version),
    appDir: resolve(root, manifest?.appDir ?? (existsSync(join(root, "app")) ? "app" : ".")),
    appRoots: manifest?.layers?.length
      ? manifest.layers.map((layer) => resolve(root, layer.root)).sort()
      : await detectNuxtAppRoots(root),
    autoImportEnabled: manifest ? manifest.autoImportEnabled === true : true,
    autoImportsAuthoritative:
      manifest?.autoImportEnabled !== undefined && isNuxtManifestCurrent(root, manifest),
    autoImports: new Map(
      (manifest?.autoImports ?? coreAutoImports()).map((entry: any) => [
        entry.as ?? entry.name,
        entry,
      ]),
    ),
    components: new Map(
      (manifest?.components ?? []).map((component: any) => [component.name, component]),
    ),
    layers: manifest?.layers ?? [{ root, priority: 0 }],
    routeRules: manifest?.routeRules ?? readRouteRules(root),
    runtimeConfig: manifest?.runtimeConfig,
    serverDirs: await serverDirs(root),
    doctorConfig: manifest?.doctorConfig,
    manifestPath,
    modules: mergeDetectedModules(manifest?.modules ?? [], deps, root),
    moduleSources: normalizeNuxtModuleSources(manifest?.moduleSources ?? []),
    manifest: createNuxtProjectInventory(root, manifest, manifestPath, readNuxtImportsDirs(root)),
  };
}

async function detectNuxtAppRoots(root: string): Promise<string[]> {
  const configs = await globFiles(root, [
    "nuxt.config.{ts,js,mjs,cjs,mts,cts}",
    "*/nuxt.config.{ts,js,mjs,cjs,mts,cts}",
    "*/*/nuxt.config.{ts,js,mjs,cjs,mts,cts}",
  ]);
  if (!configs.length) return [root];
  return [...new Set(configs.map((file) => resolve(file, "..")))].sort();
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function readRouteRules(root: string): Record<string, unknown> {
  const config =
    readFileSyncIfExists(join(root, "nuxt.config.ts")) ??
    readFileSyncIfExists(join(root, "nuxt.config.js"));
  if (!config?.includes("routeRules")) return {};
  return { __staticDetection: true };
}

function readNuxtImportsDirs(root: string): string[] {
  const config =
    readFileSyncIfExists(join(root, "nuxt.config.ts")) ??
    readFileSyncIfExists(join(root, "nuxt.config.js"));
  const importsBlock = config?.match(/\bimports\s*:\s*\{[\s\S]*?\n\s*\}/)?.[0];
  const dirsBlock = importsBlock?.match(/\bdirs\s*:\s*\[([\s\S]*?)\]/)?.[1];
  if (!dirsBlock) return [];
  return [...dirsBlock.matchAll(/["'`]([^"'`]+)["'`]/g)].map((match) => match[1]!).filter(Boolean);
}

async function serverDirs(root: string) {
  return {
    api: await globFiles(root, ["server/api/**/*.{ts,js,mjs}", "app/server/api/**/*.{ts,js,mjs}"]),
    routes: await globFiles(root, [
      "server/routes/**/*.{ts,js,mjs}",
      "app/server/routes/**/*.{ts,js,mjs}",
    ]),
    middleware: await globFiles(root, [
      "server/middleware/**/*.{ts,js,mjs}",
      "app/server/middleware/**/*.{ts,js,mjs}",
    ]),
    plugins: await globFiles(root, [
      "server/plugins/**/*.{ts,js,mjs}",
      "app/server/plugins/**/*.{ts,js,mjs}",
    ]),
  };
}

async function globFiles(root: string, patterns: string[]): Promise<string[]> {
  const files = new Set<string>();
  for (const pattern of patterns) {
    for await (const entry of glob(pattern, { cwd: root })) {
      if (typeof entry === "string") files.add(resolve(root, entry));
    }
  }
  return [...files].sort();
}

function coreAutoImports(): AutoImportEntry[] {
  return [
    "useFetch",
    "useAsyncData",
    "useRoute",
    "useRouter",
    "useRuntimeConfig",
    "useNuxtApp",
    "navigateTo",
    "defineNuxtRouteMiddleware",
    "definePageMeta",
    "useState",
  ].map((name) => ({ name, from: "#imports", kind: "nuxt" as const }));
}

function readFileSyncIfExists(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function cleanVersion(version: string): string {
  return version.replace(/^[^\d]*/, "") || version;
}

function mergeDetectedModules(
  modules: Array<{ name: string; version?: string; doctorPlugin?: string }>,
  deps: Record<string, string | undefined>,
  root: string,
) {
  const detected = new Map(modules.map((module) => [module.name, module]));
  for (const [name, version] of Object.entries(deps)) {
    if (!version) continue;
    if (
      name === "nuxt" ||
      name === "docus" ||
      name === "shadcn-nuxt" ||
      name === "@vueuse/core" ||
      name.startsWith("@nuxt/") ||
      name.startsWith("@nuxtjs/") ||
      name.startsWith("nuxt-")
    ) {
      detected.set(name, detected.get(name) ?? { name, version: cleanVersion(version) });
    }
  }
  if (extendsDocus(root)) detected.set("docus", detected.get("docus") ?? { name: "docus" });
  return [...detected.values()];
}

function extendsDocus(root: string): boolean {
  const config =
    readFileSyncIfExists(join(root, "nuxt.config.ts")) ??
    readFileSyncIfExists(join(root, "nuxt.config.js")) ??
    readFileSyncIfExists(join(root, "nuxt.config.mjs")) ??
    readFileSyncIfExists(join(root, "nuxt.config.mts"));
  return Boolean(config && /extends\s*:\s*(?:\[[^\]]*["']docus["']|["']docus["'])/.test(config));
}
