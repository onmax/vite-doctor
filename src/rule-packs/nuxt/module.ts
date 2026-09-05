import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { defineNuxtModule } from "nuxt/kit";
import type { NuxtModule } from "nuxt/schema";
import { join, relative, resolve } from "pathe";
import type {
  DoctorConfig,
  DoctorExtension,
  NuxtDoctorManifest,
  NuxtModuleSource,
  RulePack,
} from "../../core/index.js";
export type { NuxtDoctorManifest } from "../../core/index.js";

export type NuxtDoctorModuleOptions = DoctorConfig;

type EvidenceBuildManifest = {
  hasBuildManifest: boolean;
  chunks: Array<{ file?: string; src?: string; isEntry?: boolean; isDynamicEntry?: boolean }>;
};

type NuxtAutoImportContext = {
  getImports?: () => Promise<unknown[]> | unknown[];
};

type NuxtDoctorEvidence = {
  pages?: Array<{ path?: string; file?: string; name?: string }>;
  prerenderRoutes?: Set<string>;
  buildManifest?: EvidenceBuildManifest;
  componentDirs?: unknown[];
  importDirs?: unknown[];
  autoImportContext?: NuxtAutoImportContext;
};

async function setupNuxtDoctor(options: NuxtDoctorModuleOptions, nuxt: any) {
  nuxt.options ??= {};
  nuxt.options.doctor = options;

  const evidence = {
    pages: [] as Array<{ path?: string; file?: string; name?: string }>,
    prerenderRoutes: new Set<string>(),
    buildManifest: undefined as EvidenceBuildManifest | undefined,
    componentDirs: [] as unknown[],
    importDirs: [] as unknown[],
    autoImportContext: undefined as NuxtAutoImportContext | undefined,
  };

  nuxt.hook?.("imports:context", (context: NuxtAutoImportContext) => {
    evidence.autoImportContext = context;
  });

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
}

const nuxtDoctorModule: NuxtModule<NuxtDoctorModuleOptions> = defineNuxtModule({
  meta: {
    name: "vite-doctor",
    configKey: "doctor",
    compatibility: { nuxt: ">=4" },
    docs: "https://vite-doctor.onmax.me/nuxt",
  },
  setup: setupNuxtDoctor,
});

export default nuxtDoctorModule;

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
  evidence?: NuxtDoctorEvidence,
): Promise<NuxtDoctorManifest> {
  const rootDir = resolve(nuxt.options.rootDir ?? process.cwd());
  const buildDir = resolve(rootDir, nuxt.options.buildDir ?? ".nuxt");
  const srcDir = resolve(rootDir, nuxt.options.srcDir ?? ".");
  const appDir = srcDir;
  const moduleSources: NuxtModuleSource[] = [];
  await nuxt.callHook?.("doctor:extendSources", moduleSources);
  const modules = toArray(nuxt.options.modules).map((entry: any) => ({
    name:
      typeof entry === "string" ? entry : (entry?.meta?.name ?? entry?.name ?? "anonymous-module"),
    version: entry?.meta?.version,
    doctorPlugin: entry?.doctor?.plugin,
  }));
  const resolvedAutoImports = evidence?.autoImportContext?.getImports
    ? await evidence.autoImportContext.getImports()
    : toArray(nuxt.options.imports?.imports);
  const manifest = {
    nuxtConfigMtimeMs: nuxtConfigModifiedAt(rootDir),
    nuxtVersion: nuxt._version ?? nuxt.version ?? "4",
    vueVersion: nuxt.options.vue?.version ?? "3.5",
    compatibilityVersion: nuxt.options.future?.compatibilityVersion,
    rootDir,
    srcDir,
    appDir,
    buildDir,
    autoImportEnabled: nuxt.options.imports?.autoImport !== false,
    autoImportTransform: serializeImportTransform(nuxt.options.imports?.transform),
    autoImports: normalizeAutoImports(resolvedAutoImports),
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
    doctorConfig: serializableDoctorConfig(nuxt.options.doctor),
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
  const signature = JSON.stringify(manifest);
  if (
    !existsSync(manifestPath) ||
    lastManifestWrite.path !== manifestPath ||
    lastManifestWrite.signature !== signature
  ) {
    manifest.generatedAt = new Date().toISOString();
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(manifestPath, serialized);
    lastManifestWrite.path = manifestPath;
    lastManifestWrite.signature = signature;
    lastManifestWrite.generatedAt = manifest.generatedAt;
  } else {
    manifest.generatedAt = lastManifestWrite.generatedAt;
  }
  return manifest;
}

const lastManifestWrite: { path: string; signature: string; generatedAt?: string } = {
  path: "",
  signature: "",
};

function nuxtConfigModifiedAt(root: string): number | undefined {
  for (const extension of ["ts", "mts", "js", "mjs", "cjs", "cts"]) {
    const file = join(root, `nuxt.config.${extension}`);
    if (existsSync(file)) return statSync(file).mtimeMs;
  }
  return undefined;
}

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

function normalizeAutoImports(imports: unknown[]) {
  return imports
    .map((entry: any) => ({
      name: entry?.name,
      as: entry?.as,
      from: entry?.from,
      type: entry?.type === true || undefined,
    }))
    .filter((entry) => entry.name && entry.from);
}

function serializeImportTransform(transform: any) {
  const serialize = (patterns: unknown[]) =>
    patterns
      .filter((pattern): pattern is RegExp => pattern instanceof RegExp)
      .map(({ source, flags }) => ({ source, flags }));
  return {
    include: serialize(toArray(transform?.include)),
    exclude: serialize(toArray(transform?.exclude)),
  };
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

function serializableDoctorConfig(config: DoctorConfig = {}): DoctorConfig | undefined {
  const payload: DoctorConfig = {};
  if (config.extends !== undefined) payload.extends = config.extends;
  if (config.include !== undefined) payload.include = config.include;
  if (config.exclude !== undefined) payload.exclude = config.exclude;
  if (config.rules !== undefined) payload.rules = config.rules;
  if (config.suppressions !== undefined) payload.suppressions = config.suppressions;
  if (config.cache !== undefined) payload.cache = config.cache;
  if (config.score !== undefined) payload.score = config.score;
  return Object.keys(payload).length ? payload : undefined;
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
