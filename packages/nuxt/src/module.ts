import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "pathe";
import type {
  DoctorExtension,
  NuxtDoctorManifest,
  NuxtModuleSource,
  RulePack,
} from "@vue-doctor/core";
import { parseRunArgs, runNuxtDoctor } from "./cli.js";
export type { NuxtDoctorManifest } from "@vue-doctor/core";

export interface NuxtDoctorModuleOptions {
  extends?: "auto" | string[];
  extensions?: DoctorExtension[];
}

type EvidenceBuildManifest = {
  hasBuildManifest: boolean;
  chunks: Array<{ file?: string; src?: string; isEntry?: boolean; isDynamicEntry?: boolean }>;
};

export default async function nuxtDoctorModule(options: NuxtDoctorModuleOptions = {}, nuxt: any) {
  nuxt.options ??= {};
  nuxt.options.doctor ??= {};
  nuxt.options.doctor.extends ??= options.extends;
  nuxt.options.doctor.extensions ??= options.extensions;

  const evidence = {
    pages: [] as Array<{ path?: string; file?: string; name?: string }>,
    prerenderRoutes: new Set<string>(),
    buildManifest: undefined as EvidenceBuildManifest | undefined,
    componentDirs: [] as unknown[],
    importDirs: [] as unknown[],
  };

  nuxt.hook?.("pages:resolved", (pages: any[]) => {
    evidence.pages = flattenPages(pages).map((page: any) => ({
      path: page.path,
      file: page.file,
      name: page.name,
    }));
  });

  nuxt.hook?.("prerender:routes", (ctx: any) => {
    for (const route of toArray(ctx?.routes)) evidence.prerenderRoutes.add(String(route));
  });

  nuxt.hook?.("build:manifest", (manifest: Record<string, any>) => {
    evidence.buildManifest = {
      hasBuildManifest: true,
      chunks: Object.values(manifest ?? {}).map((chunk: any) => ({
        file: chunk.file,
        src: chunk.src,
        isEntry: chunk.isEntry,
        isDynamicEntry: chunk.isDynamicEntry,
      })),
    };
  });

  nuxt.hook?.("imports:dirs", (dirs: unknown[]) => {
    evidence.importDirs.push(...toArray(dirs));
  });

  nuxt.hook?.("components:dirs", (dirs: unknown[]) => {
    evidence.componentDirs.push(...toArray(dirs));
  });

  nuxt.hook?.("builder:generateApp", async () => {
    await writeManifest(nuxt, evidence);
  });

  nuxt.hook?.("prepare:types", async () => {
    await writeManifest(nuxt, evidence);
  });

  nuxt.hook?.("close", async () => {
    await writeManifest(nuxt, evidence);
  });

  nuxt.options.cli ??= {};
  nuxt.options.cli.commands ??= {};
  nuxt.options.cli.commands.doctor = {
    description: "Run Nuxt Doctor",
    async run(ctx: any) {
      const extraRulePacks = await collectNuxtDoctorRulePacks(nuxt);
      const extraExtensions = await collectNuxtDoctorExtensions(nuxt);
      const argv = Array.isArray(ctx?.rawArgs) ? ctx.rawArgs : [];
      const { path, options } = parseRunArgs(argv);
      const result = await runNuxtDoctor({
        ...options,
        extends: options.extends ?? nuxt.options.doctor?.extends,
        extensions: [
          ...(nuxt.options.doctor?.extensions ?? []),
          ...extraExtensions,
          ...(options.extensions ?? []),
        ],
        root: path === "." ? (ctx?.cwd ?? nuxt.options.rootDir) : path,
        cwd: ctx?.cwd ?? nuxt.options.rootDir,
        extraRulePacks,
      });
      if (result.summary.blocker || result.summary.error) process.exitCode = 1;
      if (options.maxWarnings !== undefined && result.summary.warn > options.maxWarnings)
        process.exitCode = 1;
    },
  };
}

export async function collectNuxtDoctorRulePacks(nuxt: any): Promise<RulePack[]> {
  const extraRulePacks: RulePack[] = [];
  await nuxt.callHook?.("doctor:extendRules", extraRulePacks);
  return extraRulePacks;
}

export async function collectNuxtDoctorExtensions(nuxt: any): Promise<DoctorExtension[]> {
  const extensions: DoctorExtension[] = [];
  await nuxt.callHook?.("doctor:extendExtensions", extensions);
  return extensions;
}

export async function writeManifest(
  nuxt: any,
  evidence?: {
    pages?: Array<{ path?: string; file?: string; name?: string }>;
    prerenderRoutes?: Set<string>;
    buildManifest?: EvidenceBuildManifest;
    componentDirs?: unknown[];
    importDirs?: unknown[];
  },
): Promise<NuxtDoctorManifest> {
  const rootDir = resolve(nuxt.options.rootDir ?? process.cwd());
  const buildDir = resolve(rootDir, nuxt.options.buildDir ?? ".nuxt");
  const appDir = resolve(rootDir, nuxt.options.appDir ?? "app");
  const moduleSources: NuxtModuleSource[] = [];
  await nuxt.callHook?.("doctor:extendSources", moduleSources);
  const modules = toArray(nuxt.options.modules).map((entry: any) => ({
    name:
      typeof entry === "string" ? entry : (entry?.meta?.name ?? entry?.name ?? "anonymous-module"),
    version: entry?.meta?.version,
    doctorPlugin: entry?.doctor?.plugin,
  }));
  const manifest = {
    nuxtVersion: nuxt._version ?? nuxt.version ?? "4",
    vueVersion: nuxt.options.vue?.version ?? "3.5",
    rootDir,
    srcDir: resolve(rootDir, nuxt.options.srcDir ?? "."),
    appDir,
    buildDir,
    autoImports: toArray(nuxt.options.imports?.imports ?? nuxt._imports?.imports),
    components: toArray(nuxt.options.components ?? nuxt._components),
    layers: toArray(nuxt.options._layers ?? [{ cwd: rootDir }]).map(
      (layer: any, index: number) => ({
        root: resolve(layer.cwd ?? layer.config?.rootDir ?? rootDir),
        name: layer.config?.name,
        priority: index,
      }),
    ),
    aliases: Object.fromEntries(
      Object.entries(nuxt.options.alias ?? {}).map(([key, value]) => [key, String(value)]),
    ),
    routeRules: nuxt.options.routeRules ?? {},
    serverHandlers: toArray(nuxt.options.serverHandlers).map((handler: any) => ({
      route: handler.route,
      file: handler.handler ? relative(rootDir, handler.handler) : handler.file,
      method: handler.method,
      middleware: handler.middleware,
    })),
    pages: evidence?.pages ?? [],
    prerenderRoutes: [
      ...new Set([
        ...toArray(nuxt.options.nitro?.prerender?.routes).map(String),
        ...[...(evidence?.prerenderRoutes ?? [])].map(String),
      ]),
    ].sort(),
    buildManifest: evidence?.buildManifest ?? { hasBuildManifest: false, chunks: [] },
    modules,
    moduleSources: moduleSources.map(normalizeModuleSource),
    runtimeConfig: redactRuntimeConfig(nuxt.options.runtimeConfig),
    keyedComposables: toArray(nuxt.options.optimization?.keyedComposables).map(String),
    importsDirs: normalizeDirs(rootDir, [
      ...toArray(nuxt.options.imports?.dirs),
      ...toArray(evidence?.importDirs),
    ]),
    pluginFiles: normalizePluginFiles(rootDir, toArray(nuxt.options.plugins)),
    appScanRoots: [appDir],
    sharedScanRoots: [resolve(rootDir, "shared/utils"), resolve(rootDir, "shared/types")],
  } as NuxtDoctorManifest;
  await nuxt.callHook?.("doctor:context", { nuxt, manifest });
  const manifestPath = join(buildDir, "doctor.manifest.json");
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (lastManifestWrite.path !== manifestPath || lastManifestWrite.content !== serialized) {
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(manifestPath, serialized);
    lastManifestWrite.path = manifestPath;
    lastManifestWrite.content = serialized;
  }
  return manifest;
}

const lastManifestWrite: { path: string; content: string } = { path: "", content: "" };

function flattenPages(pages: any[]): any[] {
  return toArray(pages).flatMap((page: any) => [page, ...flattenPages(page.children)]);
}

function toArray<T = unknown>(value: T[] | Record<string, T> | undefined | null): T[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function normalizeDirs(rootDir: string, dirs: unknown[]): string[] {
  return dirs
    .map((dir: any) => (typeof dir === "string" ? dir : dir?.path))
    .filter(Boolean)
    .map((dir: string) => resolve(rootDir, dir));
}

function normalizePluginFiles(rootDir: string, plugins: unknown[]): string[] {
  return plugins
    .map((plugin: any) => (typeof plugin === "string" ? plugin : (plugin?.src ?? plugin?.file)))
    .filter(Boolean)
    .map((file: string) => resolve(rootDir, file));
}

function normalizeModuleSource(source: NuxtModuleSource): NuxtModuleSource {
  return {
    ...source,
    root: resolve(source.root),
    packageDir: source.packageDir ? resolve(source.packageDir) : undefined,
    runtimeDirs: source.runtimeDirs?.map((dir) => resolve(dir)),
    appDirs: source.appDirs?.map((dir) => resolve(dir)),
  };
}

function redactRuntimeConfig(config: unknown): unknown {
  if (!config || typeof config !== "object") return config;
  return JSON.parse(
    JSON.stringify(config, (_key, value) => {
      if (typeof value === "string" && value.length > 0) return "<redacted>";
      return value;
    }),
  );
}
