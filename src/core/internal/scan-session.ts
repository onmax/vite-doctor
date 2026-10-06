import { randomUUID } from "node:crypto";
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
  type RulePack,
  type SourceFileHandle,
  type WorkspaceGraph,
  type WorkspacePackageActivation,
} from "../primitives.js";
import { detectProject } from "./project.js";
import { workspaceNuxtRoots, workspaceProjectView } from "./workspace-nuxt.js";
import {
  GitChangeUnavailableError,
  selectSourceInventory,
  type ScanFileEntry,
} from "./source-inventory.js";
import type { AvailableGitChangeInventory } from "./git-change-ranges.js";
import { createHelpers } from "./doctor-helpers.js";
import { RuleInputs } from "./rule-inputs.js";
import {
  cleanCacheDirectory,
  DoctorCache,
  readCacheStatus,
  type CacheStatus,
  type GraphSummary,
} from "./cache-store.js";
import { nativeMatch, sha256 } from "./utils.js";
import { doctorInternalDiagnostics } from "../internal-diagnostic-handles.js";
import {
  activatingWorkspacePackages,
  evaluateRuleApplicability,
  projectWorkspacePackages,
} from "./applicability.js";

const DEFAULT_CONFIG: DoctorConfig = {
  cache: { dir: ".vite-doctor/cache" },
};

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
  handlesByPath: Map<string, SourceFileHandle>;
  sourceTexts: Map<string, string | null>;
  facts: FileFacts[];
  graph?: WorkspaceGraph;
  graphSummary?: GraphSummary;
  diagnostics: Diagnostic[];
  suppressedDiagnostics: Diagnostic[];
  cache: DoctorCache;
  /** Digest of the Project Inventory and Rule config every cached result depends on. */
  contextKey: string;
  /** Identifies a Rule implementation and the context it ran in. */
  ruleKeys: Map<DoctorRule, string>;
  ruleInputs: RuleInputs;
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
  const root = resolve(options.root ?? options.project?.root ?? process.cwd());
  const timings: Record<string, number> = {};
  const phases: Record<string, number> = {};

  let started = performance.now();
  let config = mergeDoctorConfig(DEFAULT_CONFIG, options.config);
  const sessionBase = { root, options, config, timings };
  markSession(sessionBase, "config", started);

  started = performance.now();
  // Runs reassign `inventory` and `evidenceGaps` on the project, so a shared inventory is copied first.
  const project = options.project
    ? { ...options.project }
    : await detectProject(root, options.framework ?? "auto", options.runtimeTarget);
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
  const cache = new DoctorCache(root, cacheDirectory(root, config), options.cache !== false);
  const sourceInventory = await selectSourceInventory(root, config, options, project, cache);
  if (sourceInventory.git?.status === "unavailable") {
    throw new GitChangeUnavailableError(sourceInventory.git);
  }
  const files = sourceInventory.files;
  markSession(sessionBase, "files", started);

  const helpers = createHelpers();
  const handlesByPath = new Map<string, SourceFileHandle>();
  const context = contextKey(project, config, options);
  const ruleInputs = new RuleInputs(
    root,
    (path) => handlesByPath.get(path)?.text,
    cacheDirectory(root, config),
  );
  cache.bindInputs(ruleInputs, (path) => handlesByPath.get(path)?.hash);
  return {
    ...sessionBase,
    registry,
    project,
    files,
    gitChanges: sourceInventory.git,
    handles: [],
    handlesByPath,
    sourceTexts: new Map(),
    facts: [],
    diagnostics: [],
    suppressedDiagnostics: [],
    cache,
    contextKey: context,
    ruleKeys: ruleKeys(registry, selection.rules, context),
    ruleInputs,
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
  session.cache.persist({ prune: !session.gitChanges, files: session.files.length });
}

export function cacheDirectory(root: string, config?: DoctorConfig): string {
  return resolve(root, config?.cache?.dir ?? ".vite-doctor/cache");
}

export function cleanCache(root = process.cwd(), config?: DoctorConfig): void {
  cleanCacheDirectory(root, cacheDirectory(root, config));
}

export function cacheStatus(root = process.cwd(), config?: DoctorConfig): CacheStatus {
  return readCacheStatus(resolve(root), cacheDirectory(root, config));
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
  const nuxtRoots = workspaceNuxtRoots(project);
  if (!nuxtRoots.length) {
    return {
      rules: candidates.filter(
        (rule) => evaluateRuleApplicability(rule, project).state === "active",
      ),
      scopes: selected.scopes,
    };
  }
  const roots = projectWorkspacePackages(project).map((item) => item.root);
  const rules: DoctorRule[] = [];
  for (const rule of candidates) {
    const runActive = evaluateRuleApplicability(rule, project).state === "active";
    const active = new Set(
      roots.filter((root) =>
        nuxtRoots.includes(root)
          ? evaluateRuleApplicability(rule, workspaceProjectView(project, root)).state === "active"
          : runActive,
      ),
    );
    const scope = selected.scopes.get(rule.meta.id);
    const included = (scope ? [...scope] : roots).filter((root) => active.has(root));
    if (!included.length) continue;
    rules.push(rule);
    if (scope || included.length < roots.length)
      selected.scopes.set(rule.meta.id, new Set(included));
  }
  return { rules, scopes: selected.scopes };
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

/** Rule results depend on the whole Project Inventory and Rule config, so either change invalidates them. */
function contextKey(project: ProjectInfo, config: DoctorConfig, options: DoctorRunOptions): string {
  try {
    return sha256(
      JSON.stringify(
        { project, rules: config.rules ?? {}, extends: options.extends ?? config.extends },
        (_key, value: unknown) =>
          value instanceof Map ? [...value] : value instanceof Set ? [...value] : value,
      ),
    );
  } catch {
    // Inventory Doctor cannot serialize cannot prove a cached result still applies.
    return randomUUID();
  }
}

function ruleKeys(
  registry: RuleRegistry,
  rules: readonly DoctorRule[],
  context: string,
): Map<DoctorRule, string> {
  const packs = new Map<DoctorRule, RulePack>();
  for (const pack of registry.packs) for (const rule of pack.rules) packs.set(rule, pack);
  return new Map(
    rules.map((rule) => {
      const pack = packs.get(rule);
      return [
        rule,
        sha256(
          [
            context,
            rule.meta.id,
            rule.meta.version ?? "",
            pack?.name ?? "",
            pack?.version ?? "",
            rule.create.toString(),
          ].join("\0"),
        ).slice(0, 32),
      ];
    }),
  );
}
