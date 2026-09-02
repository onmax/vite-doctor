import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "pathe";
import type { DoctorConfig, DoctorRunOptions } from "../config.js";
import {
  defineRulePack,
  type Diagnostic,
  type FileFacts,
  type DoctorHelpers,
  type DoctorExtension,
  type DoctorRule,
  type DoctorSeverity,
  type ProjectInventoryContributor,
  type ProjectInfo,
  type RuntimeEvidenceContributor,
  type RuleCache,
  type RulePack,
  type SourceFileHandle,
  type WorkspaceGraph,
} from "../primitives.js";
import { detectProject } from "./project.js";
import {
  GitChangeUnavailableError,
  selectSourceInventory,
  type ScanFileEntry,
} from "./source-inventory.js";
import type { AvailableGitChangeInventory } from "./git-change-ranges.js";
import { createHelpers } from "./doctor-helpers.js";
import { VERSION, nativeMatch, sha256 } from "./utils.js";
import { doctorInternalDiagnostics } from "../internal-diagnostic-handles.js";
import { evaluatePackActivation, evaluateRuleApplicability } from "./applicability.js";

const DEFAULT_CONFIG: DoctorConfig = {
  cache: { dir: ".vite-doctor/cache" },
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
    this.dir = resolve(root, config.cache?.dir ?? ".vite-doctor/cache");
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
  inventoryContributors: ProjectInventoryContributor[];
  runtimeEvidenceContributors: RuntimeEvidenceContributor[];
}

export interface ScanSession {
  root: string;
  options: DoctorRunOptions;
  config: DoctorConfig;
  registry: RuleRegistry;
  project: ProjectInfo;
  files: ScanFileEntry[];
  gitChanges?: AvailableGitChangeInventory;
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
  let config = mergeDoctorConfig(DEFAULT_CONFIG, options.config);
  const sessionBase = { root, options, config, timings };
  markSession(sessionBase, "config", started);

  started = performance.now();
  const project = await detectProject(root, options.framework ?? "auto", options.runtimeTarget);
  const projectDefaults =
    project.framework === "nuxt"
      ? mergeDoctorConfig(DEFAULT_CONFIG, { cache: { dir: ".nuxt/doctor/cache" } })
      : DEFAULT_CONFIG;
  if (projectDefaults !== DEFAULT_CONFIG || project.nuxt?.doctorConfig) {
    config = mergeDoctorConfig(
      mergeDoctorConfig(projectDefaults, project.nuxt?.doctorConfig),
      options.config,
    );
    sessionBase.config = config;
  }
  const extensions = [...(config.extensions ?? []), ...(options.extensions ?? [])];
  const registry = await collectRulePacks(extensions);
  await applyProjectContributions(project, registry);
  const ruleConfigs = resolveRuleConfigs(config);
  const enabledRules = selectRules(registry, ruleConfigs, options, project);
  markSession(sessionBase, "project", started);

  started = performance.now();
  const sourceInventory = await selectSourceInventory(root, config, options, project);
  if (sourceInventory.git?.status === "unavailable") {
    throw new GitChangeUnavailableError(sourceInventory.git);
  }
  const files = sourceInventory.files;
  markSession(sessionBase, "files", started);

  const helpers = createHelpers();
  return {
    ...sessionBase,
    registry,
    project,
    files,
    gitChanges: sourceInventory.git,
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
  const dir = resolve(root, config?.cache?.dir ?? ".vite-doctor/cache");
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

async function collectRulePacks(extensions: DoctorExtension[]): Promise<{
  packs: RulePack[];
  rules: DoctorRule[];
  inventoryContributors: ProjectInventoryContributor[];
  runtimeEvidenceContributors: RuntimeEvidenceContributor[];
}> {
  const registeredPacks: RulePack[] = [];
  const inventoryContributors: ProjectInventoryContributor[] = [];
  const runtimeEvidenceContributors: RuntimeEvidenceContributor[] = [];
  for (const extension of extensions) {
    await extension.setup?.({
      registerRulePack(pack) {
        registeredPacks.push(pack);
      },
      registerReporter() {},
      registerProjectDetector() {},
      registerProjectInventoryContributor(contributor) {
        inventoryContributors.push(contributor);
      },
      registerRuntimeEvidenceContributor(contributor) {
        runtimeEvidenceContributors.push(contributor);
      },
      registerNuxtManifestContributor() {},
    });
  }
  const packs = [
    ...extensions.flatMap((extension) => extension.rulePacks ?? []),
    ...registeredPacks,
  ].map((pack) => defineRulePack(pack));
  return {
    packs,
    rules: packs.flatMap((pack) => pack.rules),
    inventoryContributors,
    runtimeEvidenceContributors,
  };
}

async function applyProjectContributions(
  project: ProjectInfo,
  registry: RuleRegistry,
): Promise<void> {
  for (const contributor of registry.inventoryContributors) {
    const contribution = await contributor.contribute(project);
    project.inventory = { ...project.inventory, [contributor.name]: contribution };
  }
  for (const contributor of registry.runtimeEvidenceContributors) {
    const contribution = await contributor.contribute(project);
    project.runtimeEvidence = { ...project.runtimeEvidence, [contributor.name]: contribution };
  }
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

  const selectedRules = resolveExtends(registry.packs, options, project);

  const candidates = registry.rules
    .filter((rule) => selectedRules.has(rule.meta.id))
    .filter((rule) => !rule.meta.requires?.nuxt || project.framework === "nuxt")
    .filter(
      (rule) =>
        !rule.meta.requires?.nitro || project.framework === "nitro" || project.framework === "nuxt",
    )
    .filter(
      (rule) =>
        !rule.meta.requires?.vue || project.framework === "vue" || project.framework === "nuxt",
    )
    .filter((rule) => !rule.meta.requires?.types || options.types)
    .filter(
      (rule) => !wanted?.length || wanted.some((pattern) => nativeMatch(rule.meta.id, pattern)),
    )
    .filter((rule) => resolvedConfig(ruleConfigs, rule.meta.id).enabled);
  const evaluated = candidates.map((rule) => ({
    rule,
    applicability: evaluateRuleApplicability(rule, project),
  }));
  return evaluated.filter((item) => item.applicability.state === "active").map((item) => item.rule);
}

function resolveExtends(
  packs: RulePack[],
  options: DoctorRunOptions,
  project: ProjectInfo,
): Set<string> {
  const requested = options.extends ?? options.config?.extends ?? "auto";
  if (requested === "auto") {
    return new Set(
      packs
        .filter((pack) => evaluatePackActivation(pack, project).state === "active")
        .flatMap((pack) => pack.presets.recommended),
    );
  }
  const selected = new Set<string>();
  for (const entry of requested) {
    if (entry === "auto") {
      for (const ruleId of packs
        .filter((pack) => evaluatePackActivation(pack, project).state === "active")
        .flatMap((pack) => pack.presets.recommended)) {
        selected.add(ruleId);
      }
      continue;
    }
    const slash = entry.lastIndexOf("/");
    if (slash === -1) throw doctorInternalDiagnostics.DOC0016({ entry });
    const packKey = entry.slice(0, slash);
    const presetName = entry.slice(slash + 1);
    const pack = packs.find((item) => rulePackKey(item) === packKey || item.name === packKey);
    if (!pack) throw doctorInternalDiagnostics.DOC0017({ entry, pack: packKey });
    const preset = pack.presets[presetName];
    if (!preset)
      throw doctorInternalDiagnostics.DOC0018({
        entry,
        pack: pack.name,
        preset: presetName,
      });
    for (const ruleId of preset) selected.add(ruleId);
  }
  return selected;
}

function rulePackKey(pack: RulePack): string {
  return pack.name.split("/").at(-1) ?? pack.name;
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
        throw doctorInternalDiagnostics.DOC0019({ ruleId, severity: String(severity) });
      resolved.set(ruleId, { enabled: true, severity, options });
      continue;
    }
    throw doctorInternalDiagnostics.DOC0020({ ruleId });
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

export function createCacheKey(session: ScanSession, phase: string, input: string): string {
  return `${phase}:${sha256(
    JSON.stringify({
      version: VERSION,
      phase,
      input,
      config: session.config.rules ?? {},
      extends: session.options.extends ?? session.config.extends,
      manifest: session.project.nuxt?.manifestPath,
      tsconfig: session.project.tsconfigPath,
    }),
  )}`;
}

function safeCacheKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, "_");
}
