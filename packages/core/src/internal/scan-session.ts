import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "pathe";
import type { DoctorConfig, DoctorRunOptions } from "../config.js";
import type {
  Diagnostic,
  FileFacts,
  DoctorHelpers,
  DoctorPlugin,
  DoctorRule,
  DoctorSeverity,
  ProjectInfo,
  RuleCache,
  RulePack,
  SourceFileHandle,
  WorkspaceGraph,
} from "../primitives.js";
import { detectProject } from "./project.js";
import { selectScanFiles, type ScanFileEntry } from "./source-inventory.js";
import { createHelpers } from "./doctor-helpers.js";
import { VERSION, nativeMatch, sha256 } from "./utils.js";

const DEFAULT_CONFIG: DoctorConfig = {
  cache: { dir: ".vue-doctor/cache" },
};

class MemoryRuleCache implements RuleCache {
  private values = new Map<string, unknown>();
  get<T = unknown>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
  set<T = unknown>(key: string, value: T): void {
    this.values.set(key, value);
  }
}

class PersistentRuleCache extends MemoryRuleCache {
  private dir: string;

  constructor(root: string, config: DoctorConfig) {
    super();
    this.dir = resolve(root, config.cache?.dir ?? ".vue-doctor/cache");
  }

  override get<T = unknown>(key: string): T | undefined {
    const memory = super.get<T>(key);
    if (memory !== undefined) return memory;
    if (!key.startsWith("fileFacts:")) return undefined;
    try {
      const value = JSON.parse(
        readFileSync(resolve(this.dir, `${safeCacheKey(key)}.json`), "utf8"),
      );
      super.set(key, value);
      return value as T;
    } catch {
      return undefined;
    }
  }

  override set<T = unknown>(key: string, value: T): void {
    super.set(key, value);
    if (!key.startsWith("fileFacts:")) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(resolve(this.dir, `${safeCacheKey(key)}.json`), JSON.stringify(value));
    } catch {
      // Cache writes are best-effort and must not change diagnostics.
    }
  }
}

interface RuleRegistry {
  packs: RulePack[];
  rules: DoctorRule[];
}

export interface ScanSession {
  root: string;
  options: DoctorRunOptions;
  config: DoctorConfig;
  registry: RuleRegistry;
  project: ProjectInfo;
  files: ScanFileEntry[];
  handles: SourceFileHandle[];
  facts: FileFacts[];
  graph?: WorkspaceGraph;
  diagnostics: Diagnostic[];
  suppressedDiagnostics: Diagnostic[];
  cache: RuleCache;
  helpers: DoctorHelpers;
  enabledRules: DoctorRule[];
  ruleConfigs: Map<string, ResolvedRuleConfig>;
  timings: Record<string, number>;
  phases: Record<string, number>;
}

export interface ResolvedRuleConfig {
  enabled: boolean;
  severity?: DoctorSeverity;
  options?: unknown;
}

export async function createScanSession(options: DoctorRunOptions): Promise<ScanSession> {
  const root = resolve(options.root ?? process.cwd());
  const timings: Record<string, number> = {};
  const phases: Record<string, number> = {};

  let started = performance.now();
  const config = mergeDoctorConfig(DEFAULT_CONFIG, options.config);
  const sessionBase = { root, options, config, timings };
  markSession(sessionBase, "config", started);

  started = performance.now();
  const project = await detectProject(root, options.framework ?? "auto");
  const plugins = [...(config.plugins ?? []), ...(options.plugins ?? [])];
  const registry = await collectRulePacks(plugins, project);
  const ruleConfigs = resolveRuleConfigs(config);
  const enabledRules = selectRules(registry, ruleConfigs, options, project);
  markSession(sessionBase, "project", started);

  started = performance.now();
  const files = await selectScanFiles(root, config, options, project);
  markSession(sessionBase, "files", started);

  const helpers = createHelpers();
  return {
    ...sessionBase,
    registry,
    project,
    files,
    handles: [],
    facts: [],
    diagnostics: [],
    suppressedDiagnostics: [],
    cache: options.cache === false ? new MemoryRuleCache() : new PersistentRuleCache(root, config),
    helpers,
    enabledRules,
    ruleConfigs,
    phases,
  };
}

export function markSession(
  session: { options: DoctorRunOptions; timings: Record<string, number> },
  name: string,
  start: number,
): void {
  if (session.options.profile) session.timings[name] = Math.round(performance.now() - start);
}

export async function runPhase(
  session: ScanSession,
  name: string,
  run: () => Promise<void> | void,
): Promise<void> {
  const started = performance.now();
  await run();
  session.phases[name] = Math.round(performance.now() - started);
}

export function cleanCache(root = process.cwd(), config?: DoctorConfig): void {
  const dir = resolve(root, config?.cache?.dir ?? ".vue-doctor/cache");
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

export function mergeDoctorConfig(defaults: DoctorConfig, config: DoctorConfig = {}): DoctorConfig {
  return {
    ...defaults,
    ...config,
    cache: { ...defaults.cache, ...config.cache },
    rules: { ...defaults.rules, ...config.rules },
    score: {
      ...defaults.score,
      ...config.score,
      weights: { ...defaults.score?.weights, ...config.score?.weights },
    },
  };
}

async function collectRulePacks(
  plugins: DoctorPlugin[],
  project: ProjectInfo,
): Promise<{ packs: RulePack[]; rules: DoctorRule[] }> {
  const registeredPacks: RulePack[] = [];
  for (const plugin of plugins) {
    await plugin.setup?.({
      registerRulePack(pack) {
        registeredPacks.push(pack);
      },
      registerReporter() {},
      registerProjectDetector() {},
      registerNuxtManifestContributor() {},
    });
  }
  const packs = [...plugins.flatMap((plugin) => plugin.rulePacks ?? []), ...registeredPacks].filter(
    (pack) => isActivePack(pack, project),
  );
  return { packs, rules: packs.flatMap((pack) => pack.rules) };
}

function isActivePack(pack: RulePack, project: ProjectInfo): boolean {
  if (!pack.activation) return true;
  if (pack.activation.nuxt && project.framework !== "nuxt") return false;
  const hasPackageOrModuleConstraints = Boolean(
    pack.activation.packages?.length || pack.activation.modules?.length,
  );
  if (!hasPackageOrModuleConstraints) return true;
  const moduleNames = new Set((project.nuxt?.modules ?? []).map((module) => module.name));
  return Boolean(
    pack.activation.packages?.some((name) => moduleNames.has(name)) ||
    pack.activation.modules?.some((name) => moduleNames.has(name)),
  );
}

function selectRules(
  registry: RuleRegistry,
  ruleConfigs: Map<string, ResolvedRuleConfig>,
  options: DoctorRunOptions,
  project: ProjectInfo,
): DoctorRule[] {
  const wanted = options.rules
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const presetRules = new Set<string>();
  if (options.preset) {
    for (const pack of registry.packs) {
      const preset = pack.presets?.[options.preset];
      if (!preset) {
        for (const rule of pack.rules) presetRules.add(rule.meta.id);
        continue;
      }
      for (const ruleId of preset) presetRules.add(ruleId);
    }
  }

  return registry.rules
    .filter((rule) => !options.preset || presetRules.has(rule.meta.id))
    .filter((rule) => !rule.meta.requires?.nuxt || project.framework === "nuxt")
    .filter(
      (rule) =>
        !rule.meta.requires?.vue || project.framework === "vue" || project.framework === "nuxt",
    )
    .filter((rule) => !rule.meta.requires?.types || options.types)
    .filter((rule) => supportsFrameworkVersion(rule, project))
    .filter(
      (rule) => !wanted?.length || wanted.some((pattern) => nativeMatch(rule.meta.id, pattern)),
    )
    .filter((rule) => resolvedConfig(ruleConfigs, rule.meta.id).enabled);
}

function resolveRuleConfigs(config: DoctorConfig): Map<string, ResolvedRuleConfig> {
  const resolved = new Map<string, ResolvedRuleConfig>();
  for (const [ruleId, value] of Object.entries(config.rules ?? {})) {
    if (value === "off") {
      resolved.set(ruleId, { enabled: false });
      continue;
    }
    if (isSeverity(value)) {
      resolved.set(ruleId, { enabled: true, severity: value });
      continue;
    }
    if (Array.isArray(value)) {
      const [severity, options] = value;
      if (!isSeverity(severity))
        throw new Error(`Invalid severity for rule "${ruleId}": ${String(severity)}`);
      resolved.set(ruleId, { enabled: true, severity, options });
      continue;
    }
    throw new Error(`Invalid config for rule "${ruleId}".`);
  }
  return resolved;
}

export function resolvedConfigFor(session: ScanSession, ruleId: string): ResolvedRuleConfig {
  return resolvedConfig(session.ruleConfigs, ruleId);
}

function resolvedConfig(
  ruleConfigs: Map<string, ResolvedRuleConfig>,
  ruleId: string,
): ResolvedRuleConfig {
  return ruleConfigs.get(ruleId) ?? { enabled: true };
}

function isSeverity(value: unknown): value is DoctorSeverity {
  return value === "blocker" || value === "error" || value === "warn" || value === "info";
}

function supportsFrameworkVersion(rule: DoctorRule, project: ProjectInfo): boolean {
  const vue = rule.meta.frameworkVersions?.vue;
  if (vue && !satisfiesVersion(project.vueVersion, vue)) return false;
  const nuxt = rule.meta.frameworkVersions?.nuxt;
  if (nuxt && !project.nuxtVersion) return false;
  if (nuxt && project.nuxtVersion && !satisfiesVersion(project.nuxtVersion, nuxt)) return false;
  return true;
}

function satisfiesVersion(version: string, range: string): boolean {
  const match = range.trim().match(/^(>=|>|<=|<|=)?\s*(\d+(?:\.\d+){0,2})/);
  if (!match) return true;
  const operator = match[1] ?? "=";
  const comparison = compareVersions(version, match[2]);
  if (operator === ">=") return comparison >= 0;
  if (operator === ">") return comparison > 0;
  if (operator === "<=") return comparison <= 0;
  if (operator === "<") return comparison < 0;
  return comparison === 0;
}

function compareVersions(left: string, right: string): number {
  const leftParts = numericVersionParts(left);
  const rightParts = numericVersionParts(right);
  for (let index = 0; index < 3; index++) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

function numericVersionParts(version: string): number[] {
  return version
    .replace(/^[^\d]*/, "")
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

export function createCacheKey(session: ScanSession, phase: string, input: string): string {
  return `${phase}:${sha256(
    JSON.stringify({
      version: VERSION,
      phase,
      input,
      config: session.config.rules ?? {},
      preset: session.options.preset,
      manifest: session.project.nuxt?.manifestPath,
      tsconfig: session.project.tsconfigPath,
    }),
  )}`;
}

function safeCacheKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, "_");
}
