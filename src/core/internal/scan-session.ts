import { randomUUID } from "node:crypto";
import { matchesGlob } from "node:path";
import { relative, resolve } from "pathe";
import type { DoctorConfig, DoctorRunOptions } from "../config.js";
import {
  defineRulePack,
  type Diagnostic,
  type DoctorRuleConfig,
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
  type RulePackActivation,
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
import { owningWorkspacePackage, packageFrameworks } from "./workspace-packages.js";
import { doctorInternalDiagnostics } from "../internal-diagnostic-handles.js";
import { reportedDoctorRuleIds } from "../diagnostic-registry.js";
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
  /**
   * Set when the run reports only some files (`changed`, `since`, or `affectedFiles`), so it can
   * skip work whose Diagnostics could only land in the files it does not report.
   */
  scopedReport: boolean;
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
  coversConfiguredPresets: boolean;
  ruleScopes: Map<string, ReadonlySet<string>>;
  workspaceActivations: WorkspacePackageActivation[];
  rulePacks: RulePackActivation[];
  ruleConfigs: Map<string, ResolvedRuleConfig>;
  ruleOverrides: ResolvedRuleOverride[];
  /** Rules that run only on the files an override turns them on for. */
  overrideOnlyRules: ReadonlySet<string>;
  /** Matching overrides per root-relative path, so each file resolves its overrides once. */
  overrideMatches: Map<string, ResolvedRuleOverride[]>;
  timings: Record<string, number>;
  phases: Record<string, number>;
  ruleTimings: Map<string, RuleTiming>;
  /** File Rules that ran on each file holding a `doctor-disable` directive, so a directive can be proven unused. */
  fileRuleRuns: Map<string, Set<string>>;
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

export interface ResolvedRuleOverride {
  files: string[];
  rules: Map<string, ResolvedRuleConfig>;
  /** Rules the override's `extends` selects for its files. */
  selects: ReadonlySet<string>;
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
  const ruleConfigs = resolveRuleConfigs(config.rules);
  const activations = resolveRulePackActivations(registry.packs, project);
  const ruleOverrides = resolveRuleOverrides(config, registry);
  const selection = selectRules(
    registry,
    ruleConfigs,
    ruleOverrides,
    options,
    config,
    project,
    activations,
  );
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
    scopedReport: Boolean(sourceInventory.git || options.affectedFiles),
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
    coversConfiguredPresets: selection.coversConfiguredPresets,
    ruleScopes: selection.scopes,
    workspaceActivations: workspacePackageActivations(project, activations),
    rulePacks: registry.packs
      .map((pack) => ({
        name: pack.name,
        selected: selection.packs.has(pack),
        activatedBy: activations.get(pack) ?? [],
      }))
      .filter((pack) => pack.selected || pack.activatedBy.length),
    ruleConfigs,
    ruleOverrides,
    overrideOnlyRules: selection.overrideOnly,
    overrideMatches: new Map(),
    phases,
    ruleTimings: new Map(),
    fileRuleRuns: new Map(),
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
  const { options } = session;
  // Scoped-report runs and Rule subset runs skip work, so they keep the results they did not touch.
  const subset = Boolean(options.rules) || Boolean(options.analyses) || session.scopedReport;
  session.cache.persist({
    files: session.files.length,
    activeRuleKeys: subset
      ? new Set(
          session.scopedReport || (options.analyses && !options.rules)
            ? []
            : session.ruleKeys.values(),
        )
      : undefined,
  });
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
  for (const overrides of [defaults.overrides, config.overrides]) {
    if (overrides !== undefined && !Array.isArray(overrides))
      throw doctorInternalDiagnostics.DOC0035({ reason: "`overrides` must be an array." });
  }
  return {
    ...defaults,
    ...config,
    cache: { ...defaults.cache, ...config.cache },
    rules: { ...defaults.rules, ...config.rules },
    overrides: [...(defaults.overrides ?? []), ...(config.overrides ?? [])],
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
  coversConfiguredPresets: boolean;
  /** Workspace package roots a file must belong to for a rule that only workspace packages activated. */
  scopes: Map<string, ReadonlySet<string>>;
  /** Rule Packs whose Presets Config Extends selected. */
  packs: ReadonlySet<RulePack>;
  /** Selected Rules that only an override turns on. */
  overrideOnly: ReadonlySet<string>;
}

function selectRules(
  registry: RuleRegistry,
  ruleConfigs: Map<string, ResolvedRuleConfig>,
  overrides: readonly ResolvedRuleOverride[],
  options: DoctorRunOptions,
  config: DoctorConfig,
  project: ProjectInfo,
  activations: ReadonlyMap<RulePack, string[]>,
): RuleSelection {
  const wanted = options.rules
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const workspaceRoots = projectWorkspacePackages(project).map((item) => item.root);
  const explicitFramework = options.framework !== undefined && options.framework !== "auto";
  const resolveSelection = (extendsSelection: DoctorRunOptions["extends"]) =>
    resolveExtends(registry.packs, extendsSelection, activations, workspaceRoots, {
      explicitFramework,
    });
  const selected = resolveSelection(options.extends ?? config.extends);
  const coversConfiguredPresets = (() => {
    if (
      options.extends === undefined ||
      options.extends === config.extends ||
      !config.suppressions?.some((suppression) => !suppression.ruleId)
    )
      return true;
    try {
      const configured = resolveSelection(config.extends);
      return [...configured.ruleIds].every((ruleId) => {
        if (!selected.ruleIds.has(ruleId)) return false;
        const scope = selected.scopes.get(ruleId);
        const configuredScope = configured.scopes.get(ruleId);
        return (
          !scope ||
          (configuredScope !== undefined && [...configuredScope].every((root) => scope.has(root)))
        );
      });
    } catch {
      return false;
    }
  })();
  // A severity turns on a Rule that no selected Preset includes, as if a Preset had named it.
  for (const [ruleId, ruleConfig] of ruleConfigs) {
    if (!ruleConfig.enabled || selected.ruleIds.has(ruleId)) continue;
    selected.ruleIds.add(ruleId);
    selected.scopes.delete(ruleId);
  }
  const turnedOnByOverride = new Set(
    overrides.flatMap((override) => [
      ...override.selects,
      ...[...override.rules].flatMap(([ruleId, ruleConfig]) =>
        ruleConfig.enabled ? [ruleId] : [],
      ),
    ]),
  );
  const overrideOnly = (rules: DoctorRule[]) =>
    new Set(rules.map((rule) => rule.meta.id).filter((ruleId) => !selected.ruleIds.has(ruleId)));
  const frameworks = new Set([
    project.framework,
    ...projectWorkspacePackages(project).flatMap(packageFrameworks),
  ]);

  const candidates = registry.rules
    .filter(
      (rule) =>
        (selected.ruleIds.has(rule.meta.id) && resolvedConfig(ruleConfigs, rule.meta.id).enabled) ||
        turnedOnByOverride.has(rule.meta.id),
    )
    .filter((rule) => !rule.meta.requires?.nuxt || frameworks.has("nuxt"))
    .filter(
      (rule) => !rule.meta.requires?.nitro || frameworks.has("nitro") || frameworks.has("nuxt"),
    )
    .filter((rule) => !rule.meta.requires?.vue || frameworks.has("vue") || frameworks.has("nuxt"))
    .filter(
      (rule) => !wanted?.length || wanted.some((pattern) => nativeMatch(rule.meta.id, pattern)),
    );
  const nuxtRoots = workspaceNuxtRoots(project);
  if (!nuxtRoots.length) {
    const rules = candidates.filter(
      (rule) => evaluateRuleApplicability(rule, project).state === "active",
    );
    return {
      rules,
      coversConfiguredPresets,
      scopes: selected.scopes,
      packs: selected.packs,
      overrideOnly: overrideOnly(rules),
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
  return {
    rules,
    coversConfiguredPresets,
    scopes: selected.scopes,
    packs: selected.packs,
    overrideOnly: overrideOnly(rules),
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
    ...(item.nuxtIntegration ? { nuxtIntegration: true as const } : {}),
    ...(item.ssr ? { ssr: item.ssr } : {}),
    rulePacks: [...activations]
      .filter(([, roots]) => roots.includes(item.root))
      .map(([pack]) => pack.name),
  }));
}

function resolveExtends(
  packs: RulePack[],
  requested: DoctorRunOptions["extends"] = "auto",
  activations: ReadonlyMap<RulePack, string[]>,
  workspaceRoots: readonly string[],
  { explicitFramework = false, override = false } = {},
): { ruleIds: Set<string>; scopes: Map<string, Set<string>>; packs: Set<RulePack> } {
  const ruleIds = new Set<string>();
  const selectedPacks = new Set<RulePack>();
  const scopes = new Map<string, Set<string>>();
  const autoScopes = new Map<string, Set<string>>();
  const matchingPacks = (key: string) => {
    const exactMatches = packs.filter((item) => item.name === key);
    return exactMatches.length ? exactMatches : packs.filter((item) => rulePackKey(item) === key);
  };
  // An entry that is itself a Rule Pack name most likely meant that pack's Recommended Preset.
  const namedPack = (entry: string) => {
    const matches = matchingPacks(entry);
    if (matches.length !== 1) return {};
    const presets = Object.entries(matches[0]!.presets)
      .filter(([, value]) => value !== undefined)
      .map(([name]) => name)
      .join(", ");
    return { rulePack: matches[0]!.name, presets };
  };
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
  // Each workspace package activates Rule Packs from its own Project Inventory, so a Rule Pack
  // the workspace root activates covers the root's own files, not every package below it.
  const selectActivated = (preset: "recommended" | "strict") => {
    for (const [pack, roots] of activations) {
      if (!roots.length) continue;
      selectedPacks.add(pack);
      const coversWorkspace =
        (explicitFramework && roots.includes(".")) || roots.length === workspaceRoots.length;
      if (!coversWorkspace)
        for (const rule of pack.rules)
          if (rule.meta.activationScope !== "workspace")
            autoScopes.set(rule.meta.id, new Set(roots));
      for (const ruleId of pack.presets[preset] ?? pack.presets.recommended)
        select(ruleId, autoScopes.get(ruleId) ? roots : undefined);
    }
  };
  for (const entry of typeof requested === "string" ? [requested] : requested) {
    if (entry === "auto") {
      selectActivated("recommended");
      continue;
    }
    if (entry === "strict") {
      selectActivated("strict");
      continue;
    }
    const slash = entry.lastIndexOf("/");
    if (slash === -1)
      throw doctorInternalDiagnostics.DOC0016({ entry, override, ...namedPack(entry) });
    const packKey = entry.slice(0, slash);
    const presetName = entry.slice(slash + 1);
    const aliasMatches = matchingPacks(packKey);
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
    if (!pack) {
      throw doctorInternalDiagnostics.DOC0017({
        entry,
        pack: packKey,
        installed: packs.map((item) => item.name).join(", "),
        ...namedPack(entry),
      });
    }
    const preset = pack.presets[presetName];
    if (!preset)
      throw doctorInternalDiagnostics.DOC0018({
        entry,
        pack: pack.name,
        preset: presetName,
      });
    selectedPacks.add(pack);
    for (const ruleId of preset) select(ruleId);
  }
  for (const [ruleId, scope] of autoScopes) if (!ruleIds.has(ruleId)) scopes.set(ruleId, scope);
  return { ruleIds, scopes, packs: selectedPacks };
}

function rulePackKey(pack: RulePack): string {
  return pack.name.split("/").at(-1) ?? pack.name;
}

function resolveRuleConfigs(
  rules: Record<string, DoctorRuleConfig> = {},
): Map<string, ResolvedRuleConfig> {
  const resolved = new Map<string, ResolvedRuleConfig>();
  for (const [ruleId, value] of Object.entries(rules)) {
    if (ruleId.startsWith("doctor/")) assertConfigurableDoctorRule(ruleId, value);
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

// Doctor reports its own Diagnostics outside any Rule, so only their severity is configurable;
// config naming any other Doctor Rule ID would otherwise be silently ignored.
function assertConfigurableDoctorRule(ruleId: string, value: DoctorRuleConfig): void {
  const doctorRuleIds = [...reportedDoctorRuleIds].join(", ");
  if (!reportedDoctorRuleIds.has(ruleId))
    throw doctorInternalDiagnostics.DOC0020({
      ruleId,
      reason: "it is not a Diagnostic that a Doctor Run reports, so config cannot change it",
      doctorRuleIds,
    });
  if (Array.isArray(value))
    throw doctorInternalDiagnostics.DOC0020({
      ruleId,
      reason: "Doctor Rule IDs take no options",
      doctorRuleIds,
    });
}

function resolveRuleOverrides(
  config: DoctorConfig,
  registry: RuleRegistry,
): ResolvedRuleOverride[] {
  if (!config.overrides?.length) return [];
  const executionKinds = new Map(registry.rules.map((rule) => [rule.meta.id, rule.meta.execution]));
  return (config.overrides ?? []).map((override, index) => {
    const invalid = (reason: string) => doctorInternalDiagnostics.DOC0035({ index, reason });
    if (typeof override !== "object" || override === null || Array.isArray(override))
      throw invalid("an override must be an object.");
    const { files, extends: entries, rules } = override;
    if (
      !Array.isArray(files) ||
      !files.length ||
      files.some((file) => typeof file !== "string" || !file)
    )
      throw invalid("`files` must be a non-empty array of globs.");
    if (
      entries !== undefined &&
      (!Array.isArray(entries) ||
        entries.some(
          (entry) => typeof entry !== "string" || entry === "auto" || entry === "strict",
        ))
    )
      throw invalid(
        '`extends` must be an array of "pack/preset" entries. "auto" and "strict" apply to the whole project, so they belong in the top-level `extends`.',
      );
    if (
      rules !== undefined &&
      (typeof rules !== "object" || rules === null || Array.isArray(rules))
    )
      throw invalid("`rules` must be an object keyed by Rule ID.");
    const resolved = resolveRuleConfigs(rules);
    for (const [ruleId, ruleConfig] of resolved) {
      const execution = executionKinds.get(ruleId);
      if (ruleConfig.options !== undefined && execution && execution !== "file")
        throw invalid(
          `set options for ${execution} Rule "${ruleId}" in top-level \`rules\`, not in an override.`,
        );
    }
    try {
      const selects = entries?.length
        ? resolveExtends(registry.packs, entries, new Map(), [], { override: true }).ruleIds
        : new Set<string>();
      return { files, rules: resolved, selects };
    } catch (error) {
      if (error instanceof Error) Object.assign(error, { doctorConfigOverride: true });
      throw error;
    }
  });
}

/** The top-level config of a Rule, before overrides. */
export function topLevelRuleConfig(session: ScanSession, ruleId: string): ResolvedRuleConfig {
  return resolvedConfig(session.ruleConfigs, ruleId);
}

const RULE_OFF: ResolvedRuleConfig = { enabled: false };

/**
 * The config of a Rule for one file: the top-level config, then each override whose `files`
 * match, in order, within the Rule's workspace Activation scope.
 */
export function fileRuleConfig(
  session: ScanSession,
  ruleId: string,
  file: string,
): ResolvedRuleConfig {
  if (!ruleInScope(session, ruleId, file)) return RULE_OFF;
  let config = resolvedConfig(session.ruleConfigs, ruleId);
  if (!session.ruleOverrides.length) return config;
  let selected = !session.overrideOnlyRules.has(ruleId);
  for (const override of matchingOverrides(session, file)) {
    if (override.selects.has(ruleId)) {
      selected = true;
      if (!config.enabled) config = { ...config, enabled: true };
    }
    const entry = override.rules.get(ruleId);
    if (!entry) continue;
    if (entry.enabled) selected = true;
    // Changing severity or turning off reports does not replace analysis options.
    config =
      entry.options === undefined && config.options !== undefined
        ? { ...entry, options: config.options }
        : entry;
  }
  return selected ? config : RULE_OFF;
}

export function ruleInScope(session: ScanSession, ruleId: string, file: string): boolean {
  const scope = session.ruleScopes.get(ruleId);
  return (
    !scope ||
    scope.has(
      owningWorkspacePackage(
        projectWorkspacePackages(session.project),
        relative(session.root, resolve(session.root, file)),
      ),
    )
  );
}

function matchingOverrides(session: ScanSession, file: string): ResolvedRuleOverride[] {
  const path = relative(session.root, resolve(session.root, file));
  let matched = session.overrideMatches.get(path);
  if (!matched) {
    matched = session.ruleOverrides.filter((override) =>
      override.files.some((pattern) => matchesGlob(path, pattern)),
    );
    session.overrideMatches.set(path, matched);
  }
  return matched;
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

/**
 * Rule results depend on the whole Project Inventory and Rule config, overrides included, so any
 * change to them invalidates every result.
 */
function contextKey(project: ProjectInfo, config: DoctorConfig, options: DoctorRunOptions): string {
  try {
    return sha256(
      JSON.stringify(
        {
          project,
          rules: config.rules ?? {},
          overrides: config.overrides ?? [],
          extends: options.extends ?? config.extends,
        },
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
            JSON.stringify(rule.meta),
            pack?.name ?? "",
            pack?.version ?? "",
            rule.create.toString(),
          ].join("\0"),
        ).slice(0, 32),
      ];
    }),
  );
}
