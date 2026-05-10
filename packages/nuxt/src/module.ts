import { mkdirSync, writeFileSync } from "node:fs";
import { createResolver, installModule } from "@nuxt/kit";
import { join, relative, resolve } from "pathe";
import type { NuxtDoctorManifest, NuxtModuleSource, RulePack } from "@vue-doctor/core";
import { parseRunArgs, runNuxtDoctor } from "./cli.js";
import { setNuxtDoctorMcpContext, type NuxtDoctorMcpContext } from "./runtime/mcp/context.js";
export type { NuxtDoctorManifest } from "@vue-doctor/core";

export interface NuxtDoctorModuleOptions {
  mcp?: boolean | NuxtDoctorMcpOptions;
}

export interface NuxtDoctorMcpOptions {
  route?: string;
  name?: string;
  description?: string;
  instructions?: string;
}

const defaultMcpOptions = {
  route: "/mcp",
  name: "Nuxt Doctor",
  description: "Read-only Nuxt Doctor reports and rule metadata for the current Nuxt project.",
  instructions:
    "Use doctor_report for project health reports. Use doctor_explain_rule before recommending a remediation for a diagnostic. The exposed tools are read-only.",
};

export default async function nuxtDoctorModule(options: NuxtDoctorModuleOptions = {}, nuxt: any) {
  nuxt.options ??= {};
  nuxt.options.doctor ??= {};
  nuxt.options.doctor.mcp ??= options.mcp ?? true;

  const resolver = createResolver(import.meta.url);

  nuxt.hook?.("builder:generateApp", async () => {
    await writeManifest(nuxt);
  });

  nuxt.hook?.("prepare:types", async () => {
    await writeManifest(nuxt);
  });

  nuxt.hook?.("close", async () => {
    await writeManifest(nuxt);
  });

  nuxt.options.cli ??= {};
  nuxt.options.cli.commands ??= {};
  nuxt.options.cli.commands.doctor = {
    description: "Run Nuxt Doctor",
    async run(ctx: any) {
      const extraRulePacks = await collectNuxtDoctorRulePacks(nuxt);
      const argv = Array.isArray(ctx?.rawArgs) ? ctx.rawArgs : [];
      const { path, options } = parseRunArgs(argv);
      const result = await runNuxtDoctor({
        ...options,
        root: path === "." ? (ctx?.cwd ?? nuxt.options.rootDir) : path,
        cwd: ctx?.cwd ?? nuxt.options.rootDir,
        extraRulePacks,
      });
      if (result.summary.blocker || result.summary.error) process.exitCode = 1;
      if (options.maxWarnings !== undefined && result.summary.warn > options.maxWarnings)
        process.exitCode = 1;
    },
  };

  await setupMcpIntegration(nuxt, resolver.resolve("./runtime/mcp/tools"));
}

export async function collectNuxtDoctorRulePacks(nuxt: any): Promise<RulePack[]> {
  const extraRulePacks: RulePack[] = [];
  await nuxt.callHook?.("doctor:extendRules", extraRulePacks);
  return extraRulePacks;
}

export function resolveNuxtDoctorMcpOptions(
  value: unknown,
): false | Required<NuxtDoctorMcpOptions> {
  if (value === false) return false;
  const overrides = typeof value === "object" && value ? (value as NuxtDoctorMcpOptions) : {};
  return { ...defaultMcpOptions, ...overrides };
}

async function setupMcpIntegration(nuxt: any, toolsDir: string): Promise<void> {
  const mcpOptions = resolveNuxtDoctorMcpOptions(nuxt.options.doctor?.mcp);
  if (!mcpOptions) return;

  const context: NuxtDoctorMcpContext = {
    rootDir: resolve(nuxt.options.rootDir ?? process.cwd()),
    async getRulePacks() {
      return collectNuxtDoctorRulePacks(nuxt);
    },
  };
  setNuxtDoctorMcpContext(context);

  nuxt.options.runtimeConfig ??= {};
  nuxt.options.runtimeConfig.doctor ??= {};
  nuxt.options.runtimeConfig.doctor.rootDir = context.rootDir;

  const generatedToolsDir = resolve(
    nuxt.options.buildDir ?? join(context.rootDir, ".nuxt"),
    "nuxt-doctor-mcp-tools",
  );
  writeMcpToolProxies(generatedToolsDir, toolsDir);

  nuxt.hook?.("mcp:definitions:paths", (paths: any) => {
    paths.tools ??= [];
    if (!paths.tools.includes(generatedToolsDir)) paths.tools.push(generatedToolsDir);
  });

  await installModule("@nuxtjs/mcp-toolkit", mcpOptions);
}

function writeMcpToolProxies(targetDir: string, toolsDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  for (const name of ["doctor-report", "doctor-rules", "doctor-explain-rule"]) {
    writeFileSync(
      join(targetDir, `${name}.mjs`),
      `export { default } from ${JSON.stringify(`${toolsDir}/${name}.mjs`)}\n`,
    );
  }
}

export async function writeManifest(nuxt: any): Promise<NuxtDoctorManifest> {
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
  const manifest: NuxtDoctorManifest = {
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
    modules,
    moduleSources: moduleSources.map(normalizeModuleSource),
    runtimeConfig: redactRuntimeConfig(nuxt.options.runtimeConfig),
    keyedComposables: toArray(nuxt.options.optimization?.keyedComposables).map(String),
    importsDirs: normalizeDirs(rootDir, toArray(nuxt.options.imports?.dirs)),
    pluginFiles: normalizePluginFiles(rootDir, toArray(nuxt.options.plugins)),
    appScanRoots: [appDir],
    sharedScanRoots: [resolve(rootDir, "shared/utils"), resolve(rootDir, "shared/types")],
  };
  await nuxt.callHook?.("doctor:context", { nuxt, manifest });
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(join(buildDir, "doctor.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
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
