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
    inventory: { packages: deps },
  };
}

async function detectProjectLanguages(
  root: string,
  hasTsconfig: boolean,
): Promise<ProjectLanguage[]> {
  let hasTypeScript = hasTsconfig;
  let hasJavaScript = false;
  for await (const entry of glob("**/*.{vue,ts,tsx,mts,cts,js,jsx,mjs,cjs}", {
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
    if (entry.endsWith(".vue")) {
      const languages = await detectVueScriptLanguages(root, entry);
      hasTypeScript ||= languages.includes("typescript");
      hasJavaScript ||= languages.includes("javascript");
    }
    if (hasTypeScript && hasJavaScript) break;
  }
  return [
    ...(hasTypeScript ? (["typescript"] as const) : []),
    ...(hasJavaScript ? (["javascript"] as const) : []),
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
  const autoImportEntries = (manifest?.autoImports ?? coreAutoImports()) as AutoImportEntry[];
  return {
    version: cleanVersion(manifest?.nuxtVersion ?? version),
    appDir: resolve(root, manifest?.appDir ?? (existsSync(join(root, "app")) ? "app" : ".")),
    appRoots: manifest?.layers?.length
      ? manifest.layers.map((layer) => resolve(root, layer.root)).sort()
      : await detectNuxtAppRoots(root),
    autoImportEnabled: manifest ? manifest.autoImportEnabled === true : true,
    autoImportsAuthoritative:
      manifest?.autoImportEnabled !== undefined && isNuxtManifestCurrent(root, manifest),
    autoImports: new Map(autoImportEntries.map((entry) => [entry.as ?? entry.name, entry])),
    autoImportEntries,
    components: new Map(
      (manifest?.components ?? []).map((component: any) => [component.name, component]),
    ),
    layers: manifest?.layers ?? [{ root, priority: 0 }],
    localLayerAliases: manifest?.localLayerAliases,
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
    api: await globFiles(root, [
      "server/api/**/*.{ts,js,mjs,mts,cts,cjs}",
      "app/server/api/**/*.{ts,js,mjs,mts,cts,cjs}",
    ]),
    routes: await globFiles(root, [
      "server/routes/**/*.{ts,js,mjs,mts,cts,cjs}",
      "app/server/routes/**/*.{ts,js,mjs,mts,cts,cjs}",
    ]),
    middleware: await globFiles(root, [
      "server/middleware/**/*.{ts,js,mjs,mts,cts,cjs}",
      "app/server/middleware/**/*.{ts,js,mjs,mts,cts,cjs}",
    ]),
    plugins: await globFiles(root, [
      "server/plugins/**/*.{ts,js,mjs,mts,cts,cjs}",
      "app/server/plugins/**/*.{ts,js,mjs,mts,cts,cjs}",
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
