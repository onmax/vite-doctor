import { randomUUID } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { resolve } from "pathe";
import type { DoctorConfig, DoctorRunOptions } from "../config.js";
import {
  defineRulePack,
  type Diagnostic,
  type FileFacts,
  type DoctorHelpers,
  type DoctorExtension,
  type DoctorExtensionInput,
  type DoctorRule,
  type DoctorSeverity,
  type ProjectInventoryContributor,
  type ProjectInfo,
  type RuntimeEvidenceContributor,
  type RuleCache,
  type RulePack,
  type SourceFileHandle,
  type WorkspaceGraph,
  type WorkspacePackageActivation,
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
import {
  activatingWorkspacePackages,
  evaluateRuleApplicability,
  projectWorkspacePackages,
} from "./applicability.js";

const DEFAULT_CONFIG: DoctorConfig = {
  cache: { dir: ".vite-doctor/cache" },
};

export interface ScanCache extends RuleCache {
  persist(options: { prune: boolean }): void;
}

class MemoryRuleCache implements ScanCache {
  private values = new Map<string, unknown>();
  get<T = unknown>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
  set<T = unknown>(key: string, value: T): void {
    this.values.set(key, value);
  }
  persist(_options: { prune: boolean }): void {}
}

const CACHE_STORE_FILE = "store.json";
const CACHE_STORE_VERSION = 1;
const PERSISTED_PREFIX = "fileFacts:";

interface CacheStore {
  version: number;
  entries: Record<string, unknown>;
}

class PersistentRuleCache extends MemoryRuleCache {
  private root: string;
  private dir: string;
  private stored: Map<string, unknown>;
  private touched = new Set<string>();
  private written = new Set<string>();

  constructor(root: string, config: DoctorConfig) {
    super();
    this.root = resolve(root);
    this.dir = resolve(root, config.cache?.dir ?? ".vite-doctor/cache");
    assertCachePath(this.root, this.dir);
    this.stored = this.load();
  }

  override get<T = unknown>(key: string): T | undefined {
    const memory = super.get<T>(key);
    if (memory !== undefined) return memory;
    if (!key.startsWith(PERSISTED_PREFIX) || !this.stored.has(key)) return undefined;
    this.touched.add(key);
    return this.stored.get(key) as T;
  }

  override set<T = unknown>(key: string, value: T): void {
    super.set(key, value);
    if (!key.startsWith(PERSISTED_PREFIX)) return;
    this.touched.add(key);
    this.written.add(key);
  }

  /**
   * Partial runs (`--changed`, `--since`) see only part of the inventory, so they keep untouched
   * entries; full runs drop them to bound the store to the current project.
   */
  override persist({ prune }: { prune: boolean }): void {
    const removed = prune ? [...this.stored.keys()].filter((key) => !this.touched.has(key)) : [];
    if (!this.written.size && !removed.length) return;
    let temporary: string | undefined;
    let lock: { fd: number; path: string } | undefined;
    try {
      mkdirSync(this.dir, { recursive: true });
      lock = acquireStoreLock(this.root, this.dir);
      // A run may have started from an older snapshot. Re-read while holding the
      // lock so concurrent runs never replace a newer store with stale entries.
      const current = this.load();
      const entries: Record<string, unknown> = {};
      for (const [key, value] of current) {
        if (
          !prune ||
          this.touched.has(key) ||
          !this.stored.has(key) ||
          JSON.stringify(value) !== JSON.stringify(this.stored.get(key))
        ) {
          entries[key] = value;
        }
      }
      for (const key of this.written) entries[key] = super.get(key);
      const target = this.storePath();
      const store: CacheStore = { version: CACHE_STORE_VERSION, entries };
      temporary = resolve(this.dir, `.doctor-${randomUUID()}.tmp`);
      assertCachePath(this.root, temporary);
      writeFileSync(temporary, JSON.stringify(store), { flag: "wx", mode: 0o600 });
      renameSync(temporary, target);
      temporary = undefined;
    } catch (error) {
      if (error instanceof LegacyStoreLockError) console.warn(error.message);
      // Cache writes are best-effort and must not change diagnostics.
    } finally {
      if (temporary) {
        try {
          rmSync(temporary, { force: true });
        } catch {}
      }
      if (lock) releaseStoreLock(lock);
    }
  }

  private load(): Map<string, unknown> {
    try {
      const store: unknown = JSON.parse(readFileSync(this.storePath(), "utf8"));
      if (
        typeof store !== "object" ||
        store === null ||
        !("version" in store) ||
        store.version !== CACHE_STORE_VERSION ||
        !("entries" in store) ||
        typeof store.entries !== "object" ||
        store.entries === null ||
        Array.isArray(store.entries)
      ) {
        return new Map();
      }
      return new Map(
        Object.entries(store.entries).filter(([key]) => key.startsWith(PERSISTED_PREFIX)),
      );
    } catch {
      return new Map();
    }
  }

  private storePath(): string {
    const path = resolve(this.dir, CACHE_STORE_FILE);
    assertCachePath(this.root, path);
    return path;
  }
}

const STORE_LOCK_PREFIX = ".store-lock-";
const LEGACY_STORE_LOCK_FILE = ".store.lock";

class LegacyStoreLockError extends Error {
  constructor() {
    super(
      "Doctor cache persistence is blocked by a legacy or unrecognized store lock; stop all Doctor processes sharing this cache, then run `vite-doctor cache clean` with the same cache configuration to rebuild it.",
    );
  }
}

function acquireStoreLock(root: string, dir: string): { fd: number; path: string } {
  if (readdirSync(dir).includes(LEGACY_STORE_LOCK_FILE)) throw new LegacyStoreLockError();
  const namespace = pidNamespaceIdentity();
  const name = `${STORE_LOCK_PREFIX}${process.pid}-${namespace ?? "unknown"}-${randomUUID()}`;
  const path = resolve(dir, name);
  assertCachePath(root, path);
  const lock = { fd: openSync(path, "wx", 0o600), path };
  try {
    writeFileSync(path, JSON.stringify({ pid: process.pid, namespace }), { flag: "w" });
    // Publish ownership atomically in the name, then check for other writers.
    // Unique claims let concurrent reclaimers remove only a dead owner's file.
    for (const entry of readdirSync(dir)) {
      if (entry === name || !entry.startsWith(STORE_LOCK_PREFIX)) continue;
      const [ownerText, ownerNamespace] = entry.slice(STORE_LOCK_PREFIX.length).split("-");
      const owner = Number(ownerText);
      if (
        !Number.isSafeInteger(owner) ||
        owner <= 0 ||
        namespace === undefined ||
        ownerNamespace === undefined ||
        !/^\d+$/.test(ownerNamespace) ||
        ownerNamespace !== namespace ||
        processIsAlive(owner)
      ) {
        if (
          !Number.isSafeInteger(owner) ||
          owner <= 0 ||
          ownerNamespace === undefined ||
          !/^\d+$/.test(ownerNamespace)
        ) {
          throw new LegacyStoreLockError();
        }
        throw new Error("Doctor cache store has an active writer.");
      }
      try {
        unlinkSync(resolve(dir, entry));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return lock;
  } catch (error) {
    releaseStoreLock(lock);
    throw error;
  }
}

function pidNamespaceIdentity(): string | undefined {
  try {
    return String(statSync("/proc/self/ns/pid").ino);
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function releaseStoreLock(lock: { fd: number; path: string }): void {
  try {
    closeSync(lock.fd);
  } catch {
  } finally {
    try {
      unlinkSync(lock.path);
    } catch {}
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
  sourceTexts: Map<string, string | null>;
  facts: FileFacts[];
  graph?: WorkspaceGraph;
  diagnostics: Diagnostic[];
  suppressedDiagnostics: Diagnostic[];
  cache: ScanCache;
  helpers: DoctorHelpers;
  enabledRules: DoctorRule[];
  ruleScopes: Map<string, ReadonlySet<string>>;
  workspaceActivations: WorkspacePackageActivation[];
  ruleConfigs: Map<string, ResolvedRuleConfig>;
  timings: Record<string, number>;
  phases: Record<string, number>;
  ruleTimings: Map<string, RuleTiming>;
}

export interface RuleTiming {
  ms: number;
  files: number;
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
  config = resolveProjectDoctorConfig(project, options.config);
  sessionBase.config = config;
  const extensions = [...(config.extensions ?? []), ...(options.extensions ?? [])];
  const registry = await collectRulePacks(extensions);
  await applyProjectContributions(project, registry);
  const ruleConfigs = resolveRuleConfigs(config);
  const activations = resolveRulePackActivations(registry.packs, project);
  const selection = selectRules(registry, ruleConfigs, options, config, project, activations);
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
    sourceTexts: new Map(),
    facts: [],
    diagnostics: [],
    suppressedDiagnostics: [],
    cache: options.cache === false ? new MemoryRuleCache() : new PersistentRuleCache(root, config),
    helpers,
    enabledRules: selection.rules,
    ruleScopes: selection.scopes,
    workspaceActivations: workspacePackageActivations(project, activations),
    ruleConfigs,
    phases,
    ruleTimings: new Map(),
  };
}

export function markSession(
  session: { options: DoctorRunOptions; timings: Record<string, number> },
  name: string,
  start: number,
): void {
  if (session.options.profile) session.timings[name] = Math.round(performance.now() - start);
}

export function recordRuleTiming(
  session: ScanSession,
  ruleId: string,
  started: number,
  files: number,
): void {
  const timing = session.ruleTimings.get(ruleId) ?? { ms: 0, files: 0 };
  timing.ms += performance.now() - started;
  timing.files += files;
  session.ruleTimings.set(ruleId, timing);
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

export function persistScanCache(session: ScanSession): void {
  session.cache.persist({ prune: !session.gitChanges });
}

export function cleanCache(root = process.cwd(), config?: DoctorConfig): void {
  const dir = resolve(root, config?.cache?.dir ?? ".vite-doctor/cache");
  assertCacheDirectory(resolve(root), dir);
  let stats;
  try {
    stats = lstatSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stats.isSymbolicLink()) {
    try {
      assertCacheDirectory(realpathSync(root), realpathSync(dir));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        rmSync(dir, { force: true });
        return;
      }
      throw error;
    }
  } else {
    assertCacheDirectory(realpathSync(root), realpathSync(dir));
    if (!stats.isDirectory()) {
      throw new Error("Doctor cache directory must be a directory.");
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

function assertCacheDirectory(root: string, dir: string): void {
  const relativeDir = relative(root, dir);
  if (
    !relativeDir ||
    isAbsolute(relativeDir) ||
    relativeDir === ".." ||
    relativeDir.startsWith(`..${sep}`)
  ) {
    throw new Error("Doctor cache directory must be inside the project root.");
  }
}

function assertCacheInside(root: string, path: string): void {
  const relativePath = relative(root, path);
  if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error("Doctor cache directory must be inside the project root.");
  }
}

function assertCachePath(root: string, path: string): void {
  assertCacheDirectory(root, path);
  const canonicalRoot = realpathSync(root);
  let current = path;
  while (true) {
    const stats = lstatSync(current, { throwIfNoEntry: false });
    if (stats) {
      let canonical: string;
      try {
        canonical = realpathSync(current);
      } catch {
        throw new Error("Doctor cache directory must be inside the project root.");
      }
      assertCacheInside(canonicalRoot, canonical);
      return;
    }
    const parent = resolve(current, "..");
    if (parent === current) return;
    current = parent;
  }
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

export function resolveProjectDoctorConfig(
  project: ProjectInfo,
  config?: DoctorConfig,
): DoctorConfig {
  const defaults =
    project.framework === "nuxt"
      ? mergeDoctorConfig(DEFAULT_CONFIG, { cache: { dir: ".nuxt/doctor/cache" } })
      : DEFAULT_CONFIG;
  return mergeDoctorConfig(mergeDoctorConfig(defaults, project.nuxt?.doctorConfig), config);
}

export async function resolveDoctorExtensions(
  inputs: readonly DoctorExtensionInput[],
): Promise<DoctorExtension[]> {
  const loaded = await Promise.all(
    inputs.map(async (input) => {
      if (typeof input !== "function") return input;
      const value = await input();
      return "default" in value ? value.default : value;
    }),
  );
  const names = new Set<string>();
  return loaded.filter((extension) => {
    if (names.has(extension.name)) return false;
    names.add(extension.name);
    return true;
  });
}

export async function collectRulePacks(inputs: readonly DoctorExtensionInput[]): Promise<{
  packs: RulePack[];
  rules: DoctorRule[];
  inventoryContributors: ProjectInventoryContributor[];
  runtimeEvidenceContributors: RuntimeEvidenceContributor[];
}> {
  const extensions = await resolveDoctorExtensions(inputs);
  const registeredPacks: RulePack[] = [];
  const inventoryContributors: ProjectInventoryContributor[] = [];
  const runtimeEvidenceContributors: RuntimeEvidenceContributor[] = [];
  for (const extension of extensions) {
    await extension.setup?.({
      registerRulePack(pack) {
        registeredPacks.push(pack);
      },
      registerProjectInventoryContributor(contributor) {
        inventoryContributors.push({
          name: contributor.name,
          contribute: contributor.contribute.bind(contributor),
        });
      },
      registerRuntimeEvidenceContributor(contributor) {
        runtimeEvidenceContributors.push({
          name: contributor.name,
          contribute: contributor.contribute.bind(contributor),
        });
      },
    });
  }
  const packs = [
    ...extensions.flatMap((extension) => extension.rulePacks ?? []),
    ...registeredPacks,
  ].map((pack) => defineRulePack(pack));
  const names = new Set<string>();
  const codes = new Set<string>();
  for (const pack of packs) {
    if (names.has(pack.name)) throw doctorInternalDiagnostics.DOC0023({ pack: pack.name });
    names.add(pack.name);
    for (const code of Object.keys(pack.diagnostics?.docsByCode ?? {})) {
      if (codes.has(code)) throw doctorInternalDiagnostics.DOC0012({ code });
      codes.add(code);
    }
  }
  assertUniqueContributors(inventoryContributors, "Project Inventory");
  assertUniqueContributors(runtimeEvidenceContributors, "Runtime Evidence");
  return {
    packs,
    rules: packs.flatMap((pack) => pack.rules),
    inventoryContributors,
    runtimeEvidenceContributors,
  };
}

function assertUniqueContributors(
  contributors: Array<{ name: string }>,
  kind: "Project Inventory" | "Runtime Evidence",
): void {
  const names = new Set<string>();
  for (const contributor of contributors) {
    if (names.has(contributor.name)) {
      throw doctorInternalDiagnostics.DOC0026({ kind, name: contributor.name });
    }
    names.add(contributor.name);
  }
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

interface RuleSelection {
  rules: DoctorRule[];
  /** Workspace package roots a file must belong to for a rule that only workspace packages activated. */
  scopes: Map<string, ReadonlySet<string>>;
}

function selectRules(
  registry: RuleRegistry,
  ruleConfigs: Map<string, ResolvedRuleConfig>,
  options: DoctorRunOptions,
  config: DoctorConfig,
  project: ProjectInfo,
  activations: ReadonlyMap<RulePack, string[]>,
): RuleSelection {
  const wanted = options.rules
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const selected = resolveExtends(registry.packs, options.extends ?? config.extends, activations);
  const frameworks = new Set([
    project.framework,
    ...projectWorkspacePackages(project).map((item) => item.framework),
  ]);

  const candidates = registry.rules
    .filter((rule) => selected.ruleIds.has(rule.meta.id))
    .filter((rule) => !rule.meta.requires?.nuxt || project.framework === "nuxt")
    .filter(
      (rule) => !rule.meta.requires?.nitro || frameworks.has("nitro") || frameworks.has("nuxt"),
    )
    .filter((rule) => !rule.meta.requires?.vue || frameworks.has("vue") || frameworks.has("nuxt"))
    .filter(
      (rule) => !wanted?.length || wanted.some((pattern) => nativeMatch(rule.meta.id, pattern)),
    )
    .filter((rule) => resolvedConfig(ruleConfigs, rule.meta.id).enabled);
  const evaluated = candidates.map((rule) => ({
    rule,
    applicability: evaluateRuleApplicability(rule, project),
  }));
  return {
    rules: evaluated
      .filter((item) => item.applicability.state === "active")
      .map((item) => item.rule),
    scopes: selected.scopes,
  };
}

function resolveRulePackActivations(
  packs: readonly RulePack[],
  project: ProjectInfo,
): Map<RulePack, string[]> {
  return new Map(packs.map((pack) => [pack, activatingWorkspacePackages(pack, project)]));
}

function workspacePackageActivations(
  project: ProjectInfo,
  activations: ReadonlyMap<RulePack, string[]>,
): WorkspacePackageActivation[] {
  return projectWorkspacePackages(project).map((item) => ({
    root: item.root,
    ...(item.name ? { name: item.name } : {}),
    framework: item.framework,
    rulePacks: [...activations]
      .filter(([, roots]) => roots.includes(item.root))
      .map(([pack]) => pack.name),
  }));
}

function resolveExtends(
  packs: RulePack[],
  requested: DoctorRunOptions["extends"] = "auto",
  activations: ReadonlyMap<RulePack, string[]>,
): { ruleIds: Set<string>; scopes: Map<string, Set<string>> } {
  const ruleIds = new Set<string>();
  const scopes = new Map<string, Set<string>>();
  const select = (ruleId: string, scope?: readonly string[]) => {
    const unscoped = ruleIds.has(ruleId) && !scopes.has(ruleId);
    ruleIds.add(ruleId);
    if (!scope) {
      scopes.delete(ruleId);
      return;
    }
    if (unscoped) return;
    scopes.set(ruleId, new Set([...(scopes.get(ruleId) ?? []), ...scope]));
  };
  // Activation by the workspace root covers the whole workspace, so only Rule Packs that
  // workspace packages alone activate are scoped to those packages' files.
  const selectActivated = () => {
    for (const [pack, roots] of activations) {
      if (!roots.length) continue;
      for (const ruleId of pack.presets.recommended) {
        select(ruleId, roots.includes(".") ? undefined : roots);
      }
    }
  };
  if (requested === "auto") {
    selectActivated();
    return { ruleIds, scopes };
  }
  for (const entry of requested) {
    if (entry === "auto") {
      selectActivated();
      continue;
    }
    const slash = entry.lastIndexOf("/");
    if (slash === -1) throw doctorInternalDiagnostics.DOC0016({ entry });
    const packKey = entry.slice(0, slash);
    const presetName = entry.slice(slash + 1);
    const exactMatches = packs.filter((item) => item.name === packKey);
    const aliasMatches = exactMatches.length
      ? exactMatches
      : packs.filter((item) => rulePackKey(item) === packKey);
    if (aliasMatches.length > 1) {
      throw doctorInternalDiagnostics.DOC0024({
        entry,
        pack: packKey,
        matches: aliasMatches
          .map((item) => item.name)
          .sort()
          .join(", "),
      });
    }
    const pack = aliasMatches[0];
    if (!pack) throw doctorInternalDiagnostics.DOC0017({ entry, pack: packKey });
    const preset = pack.presets[presetName];
    if (!preset)
      throw doctorInternalDiagnostics.DOC0018({
        entry,
        pack: pack.name,
        preset: presetName,
      });
    for (const ruleId of preset) select(ruleId);
  }
  return { ruleIds, scopes };
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
