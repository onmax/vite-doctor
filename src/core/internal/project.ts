import { existsSync, readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { join, relative, resolve } from "pathe";
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
import { ProjectFileWalk, rememberProjectFileWalk, type ProjectEntry } from "./project-files.js";
import {
  applyRuntimeTarget,
  isNuxtManifestCurrent,
  resolveNuxtCompatibility,
  resolveRuntimeGraph,
  type NuxtConfigCache,
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
    optionalDependencies?: Record<string, string>;
  }>(join(root, "package.json"));
  const deps = {
    ...packageJson?.dependencies,
    ...packageJson?.optionalDependencies,
    ...packageJson?.devDependencies,
  };
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
  const nuxtFacts = framework === "nuxt" ? readNuxtRunFacts(root) : undefined;
  const nuxt = nuxtFacts
    ? await detectNuxt(root, nuxtVersion ?? ">=4", deps, nuxtFacts)
    : undefined;
  const detectedGraph = resolveRuntimeGraph(root, framework);
  const targeted = applyRuntimeTarget(
    detectedGraph,
    nuxtFacts
      ? resolveNuxtCompatibility(
          root,
          detectedGraph,
          nuxtFacts.manifest,
          nuxtFacts.configs,
          nuxtFacts.manifestCurrent,
        )
      : undefined,
    runtimeTarget,
  );
  const resolvedNuxtVersion = targeted.graph.packages.nuxt?.version;
  const resolvedVueVersion = targeted.graph.packages.vue?.version;
  const tsconfigPath = existsSync(join(root, "tsconfig.json"))
    ? join(root, "tsconfig.json")
    : undefined;
  const walk = new ProjectFileWalk(root);
  const project: ProjectInfo = {
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
    languages: await detectProjectLanguages(walk, Boolean(tsconfigPath)),
    nuxt,
    runtimeGraph: targeted.graph,
    nuxtCompatibility: targeted.compatibility,
    inventory: { packages: deps },
  };
  rememberProjectFileWalk(project, walk);
  return project;
}

const LANGUAGE_SOURCE = /\.(?:vue|ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

// Matches `fs.glob("**/*.{vue,ts,...}")` with node_modules, dist, coverage, generated, and dot
// directories excluded, which is exactly what the shared walk skips.
async function detectProjectLanguages(
  walk: ProjectFileWalk,
  hasTsconfig: boolean,
): Promise<ProjectLanguage[]> {
  let hasTypeScript = hasTsconfig;
  let hasJavaScript = false;
  for (const entry of walk.entries()) {
    for (const path of languageSources(walk, entry)) {
      if (/\.(?:ts|tsx|mts|cts)$/.test(path)) hasTypeScript = true;
      if (/\.(?:js|jsx|mjs|cjs)$/.test(path)) hasJavaScript = true;
      if (path.endsWith(".vue")) {
        const languages = await detectVueScriptLanguages(walk.root, path);
        hasTypeScript ||= languages.includes("typescript");
        hasJavaScript ||= languages.includes("javascript");
      }
    }
    if (hasTypeScript && hasJavaScript) break;
  }
  return [
    ...(hasTypeScript ? (["typescript"] as const) : []),
    ...(hasJavaScript ? (["javascript"] as const) : []),
  ];
}

// `fs.glob` steps one level into a symlinked directory whose name matches the last segment.
function languageSources(walk: ProjectFileWalk, entry: ProjectEntry): string[] {
  if (!LANGUAGE_SOURCE.test(entry.name)) return [];
  if (entry.kind !== "symlinked-directory") return [entry.path];
  return [
    entry.path,
    ...walk
      .children(entry.path)
      .filter((name) => LANGUAGE_SOURCE.test(name))
      .map((name) => `${entry.path}/${name}`),
  ];
}

async function detectVueScriptLanguages(root: string, file: string): Promise<ProjectLanguage[]> {
  try {
    let hasTypeScript = false;
    let hasJavaScript = false;
    const source = readFileSync(join(root, file), "utf8");
    const { parse } = await import("@vue/compiler-sfc");
    const { descriptor, errors } = parse(source, { filename: file, sourceMap: false });
    for (const block of [descriptor.script, descriptor.scriptSetup]) {
      if (!block) continue;
      const lang = (block.lang ?? "js").toLowerCase();
      if (lang === "ts" || lang === "tsx") hasTypeScript = true;
      if (lang === "js" || lang === "jsx") hasJavaScript = true;
    }
    if (errors.length && !hasTypeScript && !hasJavaScript) {
      for (const lang of recoverVueScriptLanguages(source)) {
        if (lang === "typescript") hasTypeScript = true;
        if (lang === "javascript") hasJavaScript = true;
      }
    }
    return [
      ...(hasTypeScript ? (["typescript"] as const) : []),
      ...(hasJavaScript ? (["javascript"] as const) : []),
    ];
  } catch {
    return [];
  }
}

function recoverVueScriptLanguages(source: string): ProjectLanguage[] {
  const languages = new Set<ProjectLanguage>();
  let quote = "";
  for (let index = 0; index < source.length; index++) {
    if (source.startsWith("<!--", index)) {
      const end = source.indexOf("-->", index + 4);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (source[index] === "<" && /^<script(?:\s|>)/i.test(source.slice(index))) {
      let cursor = index + 1;
      let attributeQuote = "";
      for (; cursor < source.length; cursor++) {
        const character = source[cursor];
        if (attributeQuote) {
          if (character === attributeQuote) attributeQuote = "";
        } else if (character === '"' || character === "'") {
          attributeQuote = character;
        } else if (character === ">") {
          break;
        }
      }
      const attributes = source.slice(index + 7, cursor);
      const langMatch = attributes.match(/\blang\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/i);
      const lang = (langMatch?.[1] ?? langMatch?.[2] ?? langMatch?.[3] ?? "js").toLowerCase();
      if (lang === "ts" || lang === "tsx") languages.add("typescript");
      if (lang === "js" || lang === "jsx") languages.add("javascript");
      const close = source.indexOf("</script", cursor + 1);
      index = close === -1 ? cursor : close + 8;
      quote = "";
      continue;
    }
    if (source[index] === "<" && /^<template(?:\s|>)/i.test(source.slice(index))) {
      index = skipVueTemplate(source, index) - 1;
      continue;
    }
    if (quote) {
      if (source[index] === quote) quote = "";
      continue;
    }
    if (source[index] === '"' || source[index] === "'") {
      quote = source[index];
      continue;
    }
    const customBlock = source.slice(index).match(/^<([A-Za-z][\w-]*)(?:\s[^>]*)?>/);
    if (
      customBlock &&
      !/^(?:template|script|div|p|span|section|main|header|footer|component)$/i.test(customBlock[1])
    ) {
      const contentStart = index + customBlock[0].length;
      const close = new RegExp(`</${customBlock[1]}\\s*>`, "i").exec(source.slice(contentStart));
      index = close ? contentStart + close.index + close[0].length - 1 : source.length;
      continue;
    }
  }
  return [...languages];
}

function skipVueTemplate(source: string, start: number): number {
  let depth = 0;
  for (let index = start; index < source.length; index++) {
    if (source.startsWith("<!--", index)) {
      const end = source.indexOf("-->", index + 4);
      if (end === -1) return source.length;
      index = end + 2;
      continue;
    }
    if (source[index] !== "<") continue;
    const tag = source.slice(index).match(/^<(\/?)([A-Za-z][\w-]*)(?=[\s/>])/);
    if (!tag) continue;
    let cursor = index + tag[0].length;
    let quote = "";
    for (; cursor < source.length; cursor++) {
      const character = source[cursor];
      if (quote) {
        if (character === quote) quote = "";
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
    }
    if (cursor === source.length) return source.length;
    const name = tag[2].toLowerCase();
    const closing = tag[1] === "/";
    const selfClosing = source[cursor - 1] === "/";
    if (name === "template") {
      if (closing) depth--;
      else if (!selfClosing) depth++;
      if (depth === 0) return cursor + 1;
    } else if (!closing && !selfClosing && (name === "script" || name === "style")) {
      const close = new RegExp(`</${name}\\s*>`, "i").exec(source.slice(cursor + 1));
      if (!close) return source.length;
      cursor += close.index + close[0].length;
    }
    index = cursor;
  }
  return source.length;
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

interface NuxtRunFacts {
  manifest: NuxtDoctorManifest | null;
  manifestPath?: string;
  manifestCurrent: boolean;
  configs: NuxtConfigCache;
}

// Created per Doctor Run, so the manifest freshness check (a recursive server directory scan) and
// nuxt.config reads run once without outliving the run.
function readNuxtRunFacts(root: string): NuxtRunFacts {
  const manifestPath = join(root, ".nuxt/doctor.manifest.json");
  const manifest = readJson<NuxtDoctorManifest>(manifestPath);
  const configs: NuxtConfigCache = new Map();
  return {
    manifest,
    manifestPath: manifest || existsSync(manifestPath) ? manifestPath : undefined,
    manifestCurrent: isNuxtManifestCurrent(root, manifest, configs),
    configs,
  };
}

async function detectNuxt(
  root: string,
  version: string,
  deps: Record<string, string | undefined>,
  { manifest, manifestPath, manifestCurrent }: NuxtRunFacts,
): Promise<NuxtProjectInfo> {
  const config = readNuxtConfigText(root);
  const autoImportEntries = (manifest?.autoImports ?? coreAutoImports()) as AutoImportEntry[];
  return {
    version: cleanVersion(manifest?.nuxtVersion ?? version),
    appDir: resolve(root, manifest?.appDir ?? (existsSync(join(root, "app")) ? "app" : ".")),
    appRoots: manifest?.layers?.length
      ? manifest.layers.map((layer) => resolve(root, layer.root)).sort()
      : await detectNuxtAppRoots(root),
    autoImportEnabled: manifest ? manifest.autoImportEnabled === true : true,
    autoImportsAuthoritative: manifest?.autoImportEnabled !== undefined && manifestCurrent,
    autoImports: new Map(autoImportEntries.map((entry) => [entry.as ?? entry.name, entry])),
    autoImportEntries,
    components: new Map(
      (manifest?.components ?? []).map((component: any) => [component.name, component]),
    ),
    layers: manifest?.layers ?? [{ root, priority: 0 }],
    localLayerAliases: manifest?.localLayerAliases,
    routeRules: manifest?.routeRules ?? readRouteRules(config.primary),
    runtimeConfig: manifest?.runtimeConfig,
    serverDirs: await serverDirs(root),
    doctorConfig: manifest?.doctorConfig,
    manifestPath,
    modules: mergeDetectedModules(manifest?.modules ?? [], deps, config.anyFormat),
    moduleSources: normalizeNuxtModuleSources(manifest?.moduleSources ?? []),
    manifest: createNuxtProjectInventory(
      root,
      manifest,
      manifestPath,
      readNuxtImportsDirs(config.primary),
      manifestCurrent,
    ),
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

function readNuxtConfigText(root: string): { primary: string | null; anyFormat: string | null } {
  const primary =
    readFileSyncIfExists(join(root, "nuxt.config.ts")) ??
    readFileSyncIfExists(join(root, "nuxt.config.js"));
  return {
    primary,
    anyFormat:
      primary ??
      readFileSyncIfExists(join(root, "nuxt.config.mjs")) ??
      readFileSyncIfExists(join(root, "nuxt.config.mts")),
  };
}

function readRouteRules(config: string | null): Record<string, unknown> {
  if (!config?.includes("routeRules")) return {};
  return { __staticDetection: true };
}

function readNuxtImportsDirs(config: string | null): string[] {
  const importsBlock = config?.match(/\bimports\s*:\s*\{[\s\S]*?\n\s*\}/)?.[0];
  const dirsBlock = importsBlock?.match(/\bdirs\s*:\s*\[([\s\S]*?)\]/)?.[1];
  if (!dirsBlock) return [];
  return [...dirsBlock.matchAll(/["'`]([^"'`]+)["'`]/g)].map((match) => match[1]!).filter(Boolean);
}

const SERVER_DIRECTORIES = ["api", "routes", "middleware", "plugins"] as const;

async function serverDirs(root: string): Promise<NuxtProjectInfo["serverDirs"]> {
  const directories: NuxtProjectInfo["serverDirs"] = {
    api: [],
    routes: [],
    middleware: [],
    plugins: [],
  };
  const files = await globFiles(
    root,
    SERVER_DIRECTORIES.flatMap((directory) => [
      `server/${directory}/**/*.{ts,js,mjs,mts,cts,cjs}`,
      `app/server/${directory}/**/*.{ts,js,mjs,mts,cts,cjs}`,
    ]),
  );
  for (const file of files) {
    const path = relative(root, file).replace(/^app\//, "");
    const directory = SERVER_DIRECTORIES.find((name) => path.startsWith(`server/${name}/`));
    if (directory) directories[directory].push(file);
  }
  return directories;
}

async function globFiles(root: string, patterns: string[]): Promise<string[]> {
  const files = new Set<string>();
  for await (const entry of glob(patterns, { cwd: root })) {
    if (typeof entry === "string") files.add(resolve(root, entry));
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
  config: string | null,
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
  if (extendsDocus(config)) detected.set("docus", detected.get("docus") ?? { name: "docus" });
  return [...detected.values()];
}

function extendsDocus(config: string | null): boolean {
  return Boolean(config && /extends\s*:\s*(?:\[[^\]]*["']docus["']|["']docus["'])/.test(config));
}
