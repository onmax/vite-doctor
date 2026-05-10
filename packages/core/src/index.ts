import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { matchesGlob } from "node:path";
import { createHash } from "node:crypto";
import { dirname, relative, resolve } from "pathe";
import MagicString from "magic-string";
import { loadConfig } from "c12";
import { visitorKeys } from "oxc-parser";
import pc from "picocolors";
import { x } from "tinyexec";
import type {
  Diagnostic,
  DoctorFramework,
  DoctorHelpers,
  DoctorPlugin,
  DoctorRunResult,
  DoctorRule,
  ProjectInfo,
  RuleCache,
  RuleContext,
  RulePack,
  RuleVisitor,
  SourceFileHandle,
} from "./primitives.js";
import { detectProject } from "./internal/project.js";
import { createVueScriptForParsing, parseSfcFile } from "./internal/sfc.js";
import { parseScript } from "./internal/script.js";
import { parseTemplate } from "./internal/template.js";

export * from "./primitives.js";
export { default as vueRulePack } from "./rules/vue.js";

export interface DoctorConfig {
  extends?: string[];
  plugins?: DoctorPlugin[];
  include?: string[];
  exclude?: string[];
  rules?: Record<string, "off" | "info" | "warn" | "error" | "blocker" | [string, unknown]>;
  suppressions?: Array<{ ruleId?: string; fingerprint?: string; file?: string; reason: string }>;
  typeAware?: boolean;
  cache?: { dir?: string; strategy?: "content-hash" };
  score?: { weights?: Partial<Record<"blocker" | "error" | "warn" | "info", number>> };
}

export interface DoctorRunOptions {
  root?: string;
  /**
   * Load executable doctor.config.* from the scan root.
   *
   * Keep this disabled for scans of repositories you do not fully trust.
   */
  config?: boolean;
  framework?: "auto" | DoctorFramework;
  preset?: string;
  changed?: boolean;
  since?: string;
  format?: string;
  baseline?: string;
  updateBaseline?: boolean;
  newOnly?: boolean;
  severity?: "error" | "warn" | "info";
  rules?: string;
  types?: boolean;
  profile?: boolean;
  cache?: boolean;
  fix?: boolean;
  unsafeFix?: boolean;
  scoreOnly?: boolean;
  maxWarnings?: number;
  plugins?: DoctorPlugin[];
}

export function defineDoctorConfig(config: DoctorConfig): DoctorConfig {
  return config;
}

const VERSION = "0.0.0";
const DEFAULT_INCLUDE = ["**/*.{vue,ts,tsx,js,mjs,cjs}"];
const CONTENT_INCLUDE = ["content/**/*.{md,mdc}"];
const DEFAULT_EXCLUDE = [
  "**/node_modules/**",
  "**/.nuxt/**",
  "**/.output/**",
  "**/dist/**",
  "**/coverage/**",
  "**/generated/**",
  "**/{test,tests,__tests__,fixtures}/**",
  "**/*.{test,spec}.{ts,tsx,js,mjs,cjs,vue}",
  "doctor.config.*",
];
const DEFAULT_WEIGHTS = { blocker: 15, error: 8, warn: 3, info: 1 };

class MemoryRuleCache implements RuleCache {
  private values = new Map<string, unknown>();
  get<T = unknown>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
  set<T = unknown>(key: string, value: T): void {
    this.values.set(key, value);
  }
}

interface RuleRegistry {
  packs: RulePack[];
  rules: DoctorRule[];
}

interface ScanFileEntry {
  path: string;
  displayPath: string;
  sourceKind: SourceFileHandle["sourceKind"];
  moduleName?: string;
}

interface ScanSession {
  root: string;
  options: DoctorRunOptions;
  config: DoctorConfig;
  registry: RuleRegistry;
  project: ProjectInfo;
  files: ScanFileEntry[];
  handles: SourceFileHandle[];
  diagnostics: Diagnostic[];
  suppressedDiagnostics: Diagnostic[];
  cache: RuleCache;
  helpers: DoctorHelpers;
  enabledRules: DoctorRule[];
  timings: Record<string, number>;
}

interface MutableRuleContext extends RuleContext {
  setFile(file: SourceFileHandle): void;
}

export async function runDoctor(options: DoctorRunOptions = {}): Promise<DoctorRunResult> {
  const session = await createScanSession(options);
  await parseSourceFiles(session);
  await runEnabledRules(session);
  applyRequestedFixes(session);
  applyPolicyFilters(session);

  const started = performance.now();
  const result = createResult(
    session.project,
    session.root,
    session.diagnostics,
    session.suppressedDiagnostics,
    session.config,
    options.profile ? session.timings : undefined,
  );
  markSession(session, "score", started);
  return result;
}

async function createScanSession(options: DoctorRunOptions): Promise<ScanSession> {
  const root = resolve(options.root ?? process.cwd());
  const timings: Record<string, number> = {};

  let started = performance.now();
  const config = options.config
    ? ((
        await loadConfig<DoctorConfig>({
          cwd: root,
          name: "doctor",
          configFile: "doctor.config",
          dotenv: false,
          globalRc: false,
        })
      ).config ?? {})
    : {};
  const sessionBase = { root, options, config, timings };
  markSession(sessionBase, "config", started);

  started = performance.now();
  const project = await detectProject(root, options.framework ?? "auto");
  const plugins = [...(config.plugins ?? []), ...(options.plugins ?? [])];
  const registry = await collectRulePacks(plugins, project);
  markSession(sessionBase, "project", started);

  started = performance.now();
  const files = await selectFiles(root, config, options, project);
  markSession(sessionBase, "files", started);

  const helpers = createHelpers();
  return {
    ...sessionBase,
    registry,
    project,
    files,
    handles: [],
    diagnostics: [],
    suppressedDiagnostics: [],
    cache: new MemoryRuleCache(),
    helpers,
    enabledRules: selectRules(registry.rules, config, options, project.framework),
  };
}

async function parseSourceFiles(session: ScanSession): Promise<void> {
  const started = performance.now();
  for (const file of session.files) {
    session.handles.push(parseSourceFile(session, file));
  }
  markSession(session, "parse", started);
}

function parseSourceFile(session: ScanSession, file: ScanFileEntry): SourceFileHandle {
  const absolute = file.path;
  const text = readFileSync(absolute, "utf8");
  const hash = sha256(text);
  const isVueSfc = absolute.endsWith(".vue");
  const sfc = isVueSfc ? parseSfcFile(absolute, text, hash) : undefined;
  const script = isVueSfc ? createVueScriptForParsing(sfc?.descriptor as any, text) : undefined;
  const scriptText = script?.text ?? text;
  const scriptAst = scriptText.trim() ? parseScript(absolute, scriptText, script?.lang) : null;
  const templateAst = isVueSfc ? parseTemplate(absolute, text) : null;
  return {
    path: absolute,
    relativePath: file.displayPath,
    sourceKind: file.sourceKind,
    moduleName: file.moduleName,
    text,
    hash,
    isVueSfc,
    scriptAst,
    templateAst,
    sfc,
    project: session.project,
    matches(pattern) {
      return nativeMatch(this.relativePath, pattern);
    },
    inAppDir(dir) {
      const appDir = session.project.nuxt?.appDir
        ? relative(session.root, session.project.nuxt.appDir)
        : "app";
      return this.relativePath.startsWith(`${appDir}/${dir}/`);
    },
    isModuleSource() {
      return this.sourceKind === "module";
    },
  };
}

async function runEnabledRules(session: ScanSession): Promise<void> {
  const started = performance.now();
  const fallbackFile = session.handles[0] ?? createEmptySourceFileHandle(session);
  for (const rule of session.enabledRules) {
    const lifecycleVisitor = await rule.create(createRuleContext(session, fallbackFile));
    await lifecycleVisitor?.onWorkspaceStart?.();
    await lifecycleVisitor?.onProjectStart?.(session.project);
    if (session.project.nuxt) lifecycleVisitor?.NuxtManifest?.(session.project.nuxt);
    for (const file of session.handles) {
      if (!canRunRuleOnFile(rule, file, session.options)) continue;
      const visitor = await rule.create(createRuleContext(session, file));
      if (!visitor) continue;
      await runVisitor(visitor, file);
    }
    await lifecycleVisitor?.onProjectEnd?.(session.project);
    await lifecycleVisitor?.onWorkspaceEnd?.();
  }
  markSession(session, "rules", started);
}

function createRuleContext(
  session: ScanSession,
  initialFile: SourceFileHandle,
): MutableRuleContext {
  let file = initialFile;
  return {
    get project() {
      return session.project;
    },
    get file() {
      return file;
    },
    get sfc() {
      return file.sfc;
    },
    setFile(nextFile) {
      file = nextFile;
    },
    report(diagnostic) {
      const next = {
        ...diagnostic,
        fingerprint:
          diagnostic.fingerprint ?? createDiagnosticFingerprint(session.root, diagnostic, file),
      };
      session.diagnostics.push(next);
    },
    getFileText(target) {
      return readFileSync(resolve(session.root, target), "utf8");
    },
    getJson<T = unknown>(target: string): T | null {
      try {
        return JSON.parse(readFileSync(resolve(session.root, target), "utf8")) as T;
      } catch {
        return null;
      }
    },
    cache: session.cache,
    helpers: session.helpers,
    range(nodeOrStart, end) {
      if (!nodeOrStart) return undefined;
      if (typeof nodeOrStart === "number")
        return session.helpers.rangeFromOffsets(file.path, file.text, nodeOrStart, end);
      const node = nodeOrStart as { start?: number; end?: number; range?: [number, number] };
      const start = node.start ?? node.range?.[0];
      const stop = node.end ?? node.range?.[1] ?? start;
      return typeof start === "number"
        ? session.helpers.rangeFromOffsets(file.path, file.text, start, stop)
        : undefined;
    },
  };
}

function createEmptySourceFileHandle(session: ScanSession): SourceFileHandle {
  const path = resolve(session.root, "__doctor_empty__.ts");
  return {
    path,
    relativePath: "__doctor_empty__.ts",
    sourceKind: "app",
    text: "",
    hash: sha256(""),
    isVueSfc: false,
    scriptAst: null,
    templateAst: null,
    project: session.project,
    matches(pattern) {
      return nativeMatch(this.relativePath, pattern);
    },
    inAppDir() {
      return false;
    },
    isModuleSource() {
      return false;
    },
  };
}

function canRunRuleOnFile(
  rule: DoctorRule,
  file: SourceFileHandle,
  options: DoctorRunOptions,
): boolean {
  if (rule.meta.sourceKinds && !rule.meta.sourceKinds.includes(file.sourceKind)) return false;
  const requires = rule.meta.requires;
  if (!requires) return true;
  if (requires.sfc && !file.sfc) return false;
  if (requires.template && !file.templateAst) return false;
  if (requires.script && !file.scriptAst) return false;
  if (requires.types && !options.types) return false;
  return true;
}

function applyRequestedFixes(session: ScanSession): void {
  if (!session.options.fix && !session.options.unsafeFix) return;
  const started = performance.now();
  applyFixes(session.diagnostics, session.options.unsafeFix);
  markSession(session, "fix", started);
}

function applyPolicyFilters(session: ScanSession): void {
  const suppressed: Diagnostic[] = [];
  const baseline = readBaseline(session.root, session.options.baseline);
  const nextDiagnostics: Diagnostic[] = [];
  for (const diagnostic of session.diagnostics) {
    const suppression = findSuppression(session, diagnostic);
    const inBaseline = baseline.has(diagnostic.fingerprint ?? "");
    if (suppression || (session.options.newOnly && inBaseline)) {
      suppressed.push({
        ...diagnostic,
        suppressed: true,
        suppressionReason: suppression ?? (inBaseline ? "baseline" : undefined),
      });
      continue;
    }
    nextDiagnostics.push(diagnostic);
  }
  session.diagnostics = nextDiagnostics;
  session.suppressedDiagnostics = suppressed;
  if (session.options.updateBaseline && session.options.baseline)
    writeBaseline(session.root, session.options.baseline, [...nextDiagnostics, ...suppressed]);
}

function readBaseline(root: string, baseline?: string): Set<string> {
  if (!baseline) return new Set();
  try {
    const json = JSON.parse(readFileSync(resolve(root, baseline), "utf8"));
    const entries = Array.isArray(json?.diagnostics)
      ? json.diagnostics
      : Array.isArray(json)
        ? json
        : [];
    return new Set(entries.map((entry: any) => entry.fingerprint ?? entry).filter(Boolean));
  } catch {
    return new Set();
  }
}

function writeBaseline(root: string, baseline: string, diagnostics: Diagnostic[]): void {
  const file = resolve(root, baseline);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        version: 1,
        diagnostics: diagnostics
          .map((diagnostic) => ({
            ruleId: diagnostic.ruleId,
            file: relative(root, diagnostic.file),
            fingerprint: diagnostic.fingerprint,
          }))
          .sort((a, b) =>
            `${a.ruleId}:${a.file}:${a.fingerprint}`.localeCompare(
              `${b.ruleId}:${b.file}:${b.fingerprint}`,
            ),
          ),
      },
      null,
      2,
    )}\n`,
  );
}

function findSuppression(session: ScanSession, diagnostic: Diagnostic): string | null {
  const configured = session.config.suppressions?.find((suppression) => {
    if (suppression.ruleId && suppression.ruleId !== diagnostic.ruleId) return false;
    if (suppression.fingerprint && suppression.fingerprint !== diagnostic.fingerprint) return false;
    if (suppression.file && !nativeMatch(relative(session.root, diagnostic.file), suppression.file))
      return false;
    return true;
  });
  if (configured) return configured.reason;
  const text = readFileSync(diagnostic.file, "utf8");
  const line = diagnostic.range?.line;
  const lines = text.split(/\r?\n/);
  const nearby = line ? lines.slice(Math.max(0, line - 3), line + 1).join("\n") : text;
  const inline = nearby.match(/doctor-disable(?:-next-line)?\s+([^\s]+)(?:\s+--\s+(.+)|\s+(.+))?/);
  if (!inline) return null;
  const rules = inline[1].split(",").map((item) => item.trim());
  if (!rules.includes(diagnostic.ruleId) && !rules.includes("*")) return null;
  const reason = (inline[2] ?? inline[3] ?? "").trim();
  return reason || "missing suppression reason";
}

function markSession(
  session: { options: DoctorRunOptions; timings: Record<string, number> },
  name: string,
  start: number,
): void {
  if (session.options.profile) session.timings[name] = Math.round(performance.now() - start);
}

export function createTextReport(result: DoctorRunResult): string {
  const lines: string[] = [];
  lines.push(
    `Detected: ${result.project.framework === "nuxt" ? `Nuxt ${result.project.nuxtVersion ?? "4"} + ` : ""}Vue ${result.project.vueVersion}`,
  );
  lines.push(`Workspace: ${result.root}`);
  lines.push(`Health score: ${result.score}/100`);
  lines.push("");
  for (const severity of ["blocker", "error", "warn", "info"] as const) {
    const items = result.diagnostics.filter((d) => d.severity === severity);
    if (!items.length) continue;
    lines.push(pc.bold(labelSeverity(severity)));
    for (const diagnostic of items) {
      const loc = diagnostic.range
        ? `${diagnostic.file}:${diagnostic.range.line}:${diagnostic.range.column}`
        : diagnostic.file;
      lines.push(`  ${diagnostic.ruleId}`);
      lines.push(`    ${loc}`);
      lines.push(`    ${diagnostic.message}`);
      if (diagnostic.suggestion) lines.push(`    Fix: ${diagnostic.suggestion}`);
    }
    lines.push("");
  }
  lines.push("Summary");
  lines.push(
    `  ${result.summary.blocker} blockers, ${result.summary.error} errors, ${result.summary.warn} warnings, ${result.summary.info} info`,
  );
  lines.push(`  ${result.summary.fixable} safe fixes available`);
  if (result.timings) {
    lines.push("");
    lines.push("Timings");
    for (const [name, ms] of Object.entries(result.timings)) lines.push(`  ${name}: ${ms}ms`);
  }
  return lines.join("\n");
}

export function createJsonReport(result: DoctorRunResult): string {
  return `${JSON.stringify(
    {
      version: result.version,
      framework: result.framework,
      root: result.root,
      score: result.score,
      categoryScores: result.categoryScores,
      summary: result.summary,
      diagnostics: result.diagnostics,
      suppressedDiagnostics: result.suppressedDiagnostics,
      timings: result.timings,
    },
    null,
    2,
  )}\n`;
}

export function createSarifReport(result: DoctorRunResult): string {
  const rules = new Map<string, Diagnostic>();
  for (const diagnostic of result.diagnostics) rules.set(diagnostic.ruleId, diagnostic);
  return `${JSON.stringify(
    {
      version: "2.1.0",
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      runs: [
        {
          tool: {
            driver: {
              name: result.framework === "nuxt" ? "Nuxt Doctor" : "Vue Doctor",
              semanticVersion: result.version,
              rules: [...rules.values()].map((diagnostic) => ({
                id: diagnostic.ruleId,
                name: diagnostic.ruleId,
                shortDescription: { text: diagnostic.ruleId },
                properties: { category: diagnostic.category },
              })),
            },
          },
          results: result.diagnostics.map((diagnostic) => ({
            ruleId: diagnostic.ruleId,
            level: sarifLevel(diagnostic.severity),
            message: { text: diagnostic.message },
            partialFingerprints: { "vue-doctor/v1": diagnostic.fingerprint },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: relative(result.root, diagnostic.file) },
                  region: diagnostic.range
                    ? {
                        startLine: diagnostic.range.line,
                        startColumn: diagnostic.range.column,
                      }
                    : undefined,
                },
              },
            ],
          })),
        },
      ],
    },
    null,
    2,
  )}\n`;
}

export function createReport(result: DoctorRunResult, format = "text"): string {
  if (format === "json") return createJsonReport(result);
  if (format === "sarif") return createSarifReport(result);
  return `${createTextReport(result)}\n`;
}

export function createRulesReport(packs: RulePack[], format = "text"): string {
  const rules = packs.flatMap((pack) =>
    pack.rules.map((rule) => ({ pack: pack.name, version: pack.version, ...rule.meta })),
  );
  if (format === "json") return `${JSON.stringify({ rules }, null, 2)}\n`;
  const lines: string[] = [];
  for (const pack of packs) {
    lines.push(pack.name);
    for (const rule of pack.rules) lines.push(`  ${rule.meta.id} ${rule.meta.severity}`);
  }
  return `${lines.join("\n")}\n`;
}

export function explainRule(packs: RulePack[], ruleId: string, format = "text"): string {
  const match = packs
    .flatMap((pack) => pack.rules.map((rule) => ({ pack: pack.name, rule })))
    .find((item) => item.rule.meta.id === ruleId);
  if (!match) return format === "json" ? `${JSON.stringify({ rule: null }, null, 2)}\n` : "";
  const payload = { pack: match.pack, ...match.rule.meta };
  if (format === "json") return `${JSON.stringify(payload, null, 2)}\n`;
  const meta = match.rule.meta;
  return (
    [
      `${meta.id} (${meta.severity})`,
      meta.title,
      meta.description,
      meta.why ? `Why: ${meta.why}` : undefined,
      meta.recommendedReplacement ? `Prefer: ${meta.recommendedReplacement}` : undefined,
      meta.docsUrl ? `Docs: ${meta.docsUrl}` : undefined,
    ]
      .filter(Boolean)
      .join("\n") + "\n"
  );
}

export function cleanCache(root = process.cwd(), config?: DoctorConfig): void {
  const dir = resolve(root, config?.cache?.dir ?? ".vue-doctor/cache");
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
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
  rules: DoctorRule[],
  config: DoctorConfig,
  options: DoctorRunOptions,
  framework: DoctorFramework,
): DoctorRule[] {
  const wanted = options.rules
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return rules
    .filter((rule) => !rule.meta.requires?.nuxt || framework === "nuxt")
    .filter((rule) => !rule.meta.requires?.types || options.types)
    .filter(
      (rule) => !wanted?.length || wanted.some((pattern) => nativeMatch(rule.meta.id, pattern)),
    )
    .filter((rule) => config.rules?.[rule.meta.id] !== "off");
}

async function selectFiles(
  root: string,
  config: DoctorConfig,
  options: DoctorRunOptions,
  project: ProjectInfo,
): Promise<ScanFileEntry[]> {
  if (options.changed || options.since) {
    const changed = await gitChangedFiles(root, options.since);
    if (changed.length) {
      const includeContent = hasContentFiles(project);
      return changed
        .filter((file) =>
          includeContent
            ? /\.(vue|[cm]?[jt]sx?|mdc?)$/.test(file)
            : /\.(vue|[cm]?[jt]sx?)$/.test(file),
        )
        .filter((file) => statSync(resolve(root, file), { throwIfNoEntry: false })?.isFile())
        .map((file) => createAppFileEntry(root, file));
    }
  }
  const files = new Map<string, ScanFileEntry>();
  const exclude = [...DEFAULT_EXCLUDE, ...(config.exclude ?? [])];
  const include = config.include ?? defaultIncludeForProject(project);
  for (const pattern of include) {
    for await (const entry of glob(pattern, { cwd: root, exclude })) {
      if (typeof entry !== "string") continue;
      const absolute = resolve(root, entry);
      if (statSync(absolute, { throwIfNoEntry: false })?.isFile())
        files.set(absolute, createAppFileEntry(root, entry));
    }
  }
  for (const source of project.nuxt?.moduleSources ?? []) {
    const include = source.include?.length ? source.include : DEFAULT_INCLUDE;
    const moduleExclude = [...DEFAULT_EXCLUDE, ...(source.exclude ?? [])];
    for (const pattern of include) {
      for await (const entry of glob(pattern, { cwd: source.root, exclude: moduleExclude })) {
        if (typeof entry !== "string") continue;
        const absolute = resolve(source.root, entry);
        if (!statSync(absolute, { throwIfNoEntry: false })?.isFile()) continue;
        files.set(absolute, {
          path: absolute,
          displayPath: `${source.module}:${relative(source.root, absolute)}`,
          sourceKind: "module",
          moduleName: source.module,
        });
      }
    }
  }
  return [...files.values()].sort((a, b) => a.displayPath.localeCompare(b.displayPath));
}

function defaultIncludeForProject(project: ProjectInfo): string[] {
  if (hasContentFiles(project)) return [...DEFAULT_INCLUDE, ...CONTENT_INCLUDE];
  return DEFAULT_INCLUDE;
}

function hasContentFiles(project: ProjectInfo): boolean {
  const moduleNames = new Set((project.nuxt?.modules ?? []).map((module) => module.name));
  return moduleNames.has("@nuxt/content") || moduleNames.has("docus");
}

function createAppFileEntry(root: string, file: string): ScanFileEntry {
  const absolute = resolve(root, file);
  return {
    path: absolute,
    displayPath: relative(root, absolute),
    sourceKind: detectAppSourceKind(root, absolute),
  };
}

function detectAppSourceKind(root: string, file: string): SourceFileHandle["sourceKind"] {
  const relativePath = relative(root, file);
  return relativePath.startsWith("layers/") ? "layer" : "app";
}

async function gitChangedFiles(root: string, since?: string): Promise<string[]> {
  try {
    const args = since
      ? ["diff", "--name-only", "--diff-filter=ACMR", since, "--"]
      : ["diff", "--name-only", "--diff-filter=ACMR", "--cached", "--"];
    const { stdout } = await x("git", args, { nodeOptions: { cwd: root } });
    return stdout.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

async function runVisitor(visitor: RuleVisitor, file: SourceFileHandle) {
  if (file.sfc) visitor.SFC?.(file.sfc);
  if (file.scriptAst)
    walkScript(file.scriptAst, (node) => {
      visitor.ScriptNode?.(node);
      if ((node as any).type === "ImportDeclaration") visitor.ImportDeclaration?.(node);
    });
  if (file.templateAst) walkTemplate(file.templateAst, (node) => visitor.TemplateNode?.(node));
}

function walkScript(node: unknown, visit: (node: unknown) => void, parent?: unknown) {
  if (!node || typeof node !== "object") return;
  const typed = node as { type?: string };
  if (!typed.type) return;
  if (parent) setDoctorParent(typed, parent);
  visit(typed);
  const keys = typed.type ? visitorKeys[typed.type] : undefined;
  for (const key of keys ?? []) {
    const value = (typed as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) walkScript(child, visit, typed);
    } else if (value && typeof value === "object" && typeof (value as any).type === "string") {
      walkScript(value, visit, typed);
    }
  }
}

function setDoctorParent(node: object, parent: unknown) {
  try {
    Object.defineProperty(node, "__doctorParent", {
      value: parent,
      configurable: true,
      enumerable: false,
    });
  } catch {
    // Some parser nodes may be frozen by future parser versions.
  }
}

function walkTemplate(node: unknown, visit: (node: unknown) => void) {
  if (!node || typeof node !== "object") return;
  const typed = node as { type?: string };
  if (!typed.type) return;
  visit(typed);
  for (const key of getTemplateVisitorKeys(typed.type)) {
    const value = (typed as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) walkTemplate(child, visit);
    } else if (value && typeof value === "object" && typeof (value as any).type === "string") {
      walkTemplate(value, visit);
    }
  }
}

function getTemplateVisitorKeys(type: string): string[] {
  if (visitorKeys[type]) return visitorKeys[type];
  switch (type) {
    case "Program":
      return ["body", "templateBody"];
    case "VDocumentFragment":
    case "VElement":
      return ["children", "startTag", "endTag"];
    case "VStartTag":
      return ["attributes"];
    case "VAttribute":
      return ["key", "value"];
    case "VDirective":
      return ["key", "value"];
    case "VExpressionContainer":
      return ["expression", "references"];
    case "VForExpression":
      return ["left", "right"];
    default:
      return [];
  }
}

function applyFixes(diagnostics: Diagnostic[], includeUnsafe = false) {
  const byFile = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    if (!diagnostic.fix) continue;
    if (diagnostic.fix.kind === "suggestion") continue;
    if (diagnostic.fix.kind === "unsafe" && !includeUnsafe) continue;
    const list = byFile.get(diagnostic.file) ?? [];
    list.push(diagnostic);
    byFile.set(diagnostic.file, list);
  }
  for (const [file, items] of byFile) {
    const text = readFileSync(file, "utf8");
    const ms = new MagicString(text);
    const edits = items
      .flatMap((item) => item.fix?.edits ?? [])
      .sort((a, b) => b.range.start - a.range.start);
    for (const edit of edits) ms.overwrite(edit.range.start, edit.range.end, edit.text);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, ms.toString());
  }
}

function createResult(
  project: ProjectInfo,
  root: string,
  diagnostics: Diagnostic[],
  suppressedDiagnostics: Diagnostic[],
  config: DoctorConfig,
  timings?: Record<string, number>,
): DoctorRunResult {
  const weights = { ...DEFAULT_WEIGHTS, ...config.score?.weights };
  const summary = {
    blocker: diagnostics.filter((d) => d.severity === "blocker").length,
    error: diagnostics.filter((d) => d.severity === "error").length,
    warn: diagnostics.filter((d) => d.severity === "warn").length,
    info: diagnostics.filter((d) => d.severity === "info").length,
    fixable: diagnostics.filter((d) => d.fix?.kind === "safe").length,
  };
  const penalty = Math.min(
    100,
    summary.blocker * weights.blocker +
      summary.error * weights.error +
      summary.warn * weights.warn +
      summary.info * weights.info,
  );
  const categories: Record<string, Diagnostic[]> = {};
  for (const diagnostic of diagnostics) {
    categories[diagnostic.category] ??= [];
    categories[diagnostic.category].push(diagnostic);
  }
  const categoryScores = Object.fromEntries(
    Object.entries(categories).map(([category, items]) => {
      const categoryPenalty = Math.min(
        100,
        items.reduce((sum, item) => sum + weights[item.severity], 0),
      );
      return [category, Math.max(0, 100 - categoryPenalty)];
    }),
  );
  return {
    version: VERSION,
    framework: project.framework,
    root,
    score: Math.max(0, 100 - penalty),
    categoryScores,
    summary,
    diagnostics,
    suppressedDiagnostics,
    timings,
    project,
  };
}

function createDiagnosticFingerprint(
  root: string,
  diagnostic: Diagnostic,
  file: SourceFileHandle,
): string {
  const rel = relative(root, diagnostic.file);
  const anchor = nearestAnchor(file.text, diagnostic.range?.start ?? 0);
  const message = diagnostic.message.replace(/\s+/g, " ").replace(/['"`][^'"`]+['"`]/g, '""');
  return sha256(`${diagnostic.ruleId}:${rel}:${anchor}:${message}`);
}

function nearestAnchor(source: string, offset: number): string {
  const before = source.slice(0, offset);
  const matches = [
    ...before.matchAll(
      /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)|<([A-Z][\w.-]*)\b/g,
    ),
  ];
  const last = matches.at(-1);
  return last ? (last[1] ?? last[2] ?? last[3] ?? "file") : "file";
}

function sarifLevel(severity: Diagnostic["severity"]) {
  if (severity === "blocker" || severity === "error") return "error";
  if (severity === "warn") return "warning";
  return "note";
}

function createHelpers(): DoctorHelpers {
  return {
    rangeFromOffsets(file, source, start, end = start) {
      const prefix = source.slice(0, start);
      const lines = prefix.split(/\r?\n/);
      return { start, end, line: lines.length, column: lines.at(-1)!.length + 1 };
    },
    isInSetupLikeContext() {
      return false;
    },
    isClientOnlyExecutionContext(node, source) {
      return isClientOnlyExecutionContext(node, source);
    },
    isTypeOnlyContext(node) {
      return isTypeOnlyContext(node);
    },
    hasLocalBindingBefore(node, source) {
      return hasLocalBindingBefore(node, source);
    },
    isTypeofOperand(node) {
      return isTypeofOperand(node);
    },
    getNodeName(node) {
      return getNodeName(node);
    },
    getCalleeName(node) {
      return getCalleeName(node);
    },
    isCall(node, name) {
      return (node as any)?.type === "CallExpression" && (!name || getCalleeName(node) === name);
    },
    report(ctx, node, diagnostic) {
      ctx.report({
        ...diagnostic,
        file: diagnostic.file ?? ctx.file.path,
        range: diagnostic.range ?? (node ? ctx.range(node) : undefined),
      });
    },
    hasVueDirective(node, name, argument) {
      return ((node as any)?.startTag?.attributes ?? []).some(
        (attr: any) =>
          attr.directive &&
          attr.key?.name?.name === name &&
          (!argument || attr.key?.argument?.name === argument),
      );
    },
    hasVueAttribute(node, name) {
      return ((node as any)?.startTag?.attributes ?? []).some(
        (attr: any) => !attr.directive && attr.key?.name === name,
      );
    },
    getStaticVueAttributeValue(node, name) {
      const attr = ((node as any)?.startTag?.attributes ?? []).find(
        (item: any) => !item.directive && item.key?.name === name,
      );
      return attr?.value?.value ?? null;
    },
    isNuxtServerFile(relativePath) {
      return relativePath.startsWith("server/") || relativePath.startsWith("app/server/");
    },
    isLikelyEventHandler(text, offset) {
      const before = text.slice(Math.max(0, offset - 180), offset);
      return /function\s+on[A-Z]\w+|const\s+on[A-Z]\w+\s*=|@click|v-on:click|addEventListener|onMounted\s*\(/.test(
        before,
      );
    },
  };
}

const CLIENT_LIFECYCLE_CALLEES = new Set([
  "onMounted",
  "onBeforeMount",
  "onUnmounted",
  "onBeforeUnmount",
  "onNuxtReady",
  "onPrehydrate",
]);

const CLIENT_EVENT_CALLEES = new Set([
  "addEventListener",
  "window.addEventListener",
  "document.addEventListener",
  "useEventListener",
  "onKeyDown",
  "onKeyUp",
  "onKeyStroke",
  "onClickOutside",
  "onLongPress",
  "usePointerSwipe",
  "useSwipe",
  "useIntersectionObserver",
  "useResizeObserver",
]);

const DEFERRED_CALLBACK_CALLEES = new Set(["watch", "watchPostEffect"]);
const TIMER_CALLBACK_CALLEES = new Set([
  "setTimeout",
  "setInterval",
  "requestAnimationFrame",
  "requestIdleCallback",
]);

function isClientOnlyExecutionContext(node: unknown, source: string): boolean {
  const parents = getDoctorParents(node);
  if (parents.some((parent) => isClientGuardAncestor(parent, node, source))) return true;
  if (parents.some((parent) => isShortCircuitedByClientGuard(parent, node, source))) return true;
  if (
    parents.some((parent) => {
      const callee = getCalleeName(parent);
      return (
        !!callee &&
        (CLIENT_LIFECYCLE_CALLEES.has(callee) ||
          CLIENT_EVENT_CALLEES.has(callee) ||
          callee.endsWith(".addEventListener"))
      );
    })
  )
    return true;

  const functionAncestors = parents.filter((parent) => isFunctionLike(parent));
  if (!functionAncestors.length) return false;

  return functionAncestors.some((functionAncestor) => {
    if (isClientOnlyCallback(functionAncestor, source)) return true;
    if (isDeferredCallback(functionAncestor)) return true;
    if (isComputedSetter(functionAncestor)) return true;
    if (isClientOnlyObjectCallback(functionAncestor)) return true;
    const propertyName = getObjectPropertyKeyName(functionAncestor);
    if (propertyName && /^on[A-Z]/.test(propertyName)) return true;
    const name = getFunctionLikeName(functionAncestor);
    return (
      !!name &&
      (isTemplateEventHandlerReference(source, name) ||
        isReturnedComposableFunction(functionAncestor) ||
        isOnlyCalledFromClientOnlyContext(name, functionAncestor, parents.at(-1), source))
    );
  });
}

function getDoctorParents(node: unknown): any[] {
  const parents = [];
  const seen = new Set<unknown>();
  let current = (node as any)?.__doctorParent;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    parents.push(current);
    current = current.__doctorParent;
  }
  return parents;
}

function isClientGuardAncestor(parent: unknown, node: unknown, source: string): boolean {
  const value = parent as any;
  if (value?.type !== "IfStatement" && value?.type !== "ConditionalExpression") return false;
  if (!isDescendantOf((node as any)?.__doctorParent, value.consequent)) return false;
  return (
    isClientGuardText(source.slice(value.test?.start ?? 0, value.test?.end ?? 0)) ||
    isClientGuardText(source.slice(value.start ?? 0, value.consequent?.start ?? value.end ?? 0))
  );
}

function isShortCircuitedByClientGuard(parent: unknown, node: unknown, source: string): boolean {
  const value = parent as any;
  if (value?.type !== "LogicalExpression" || value.operator !== "&&") return false;
  if (!isDescendantOf((node as any)?.__doctorParent, value.right)) return false;
  return isClientGuardText(source.slice(value.left?.start ?? 0, value.left?.end ?? 0));
}

function isDescendantOf(node: unknown, ancestor: unknown): boolean {
  let current = node as any;
  while (current && typeof current === "object") {
    if (current === ancestor) return true;
    current = current.__doctorParent;
  }
  return false;
}

function isClientGuardText(text: string): boolean {
  return (
    /\b(import\.meta\.client|process\.client)\b|(?:^|[^\w$])(isBrowser|isClient)\(\)/.test(text) ||
    /typeof\s+(window|document|localStorage|sessionStorage|navigator)\s*!==?\s*["']undefined["']/.test(
      text,
    )
  );
}

function isFunctionLike(node: unknown): boolean {
  return ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
    (node as any)?.type,
  );
}

function isClientOnlyCallback(functionNode: unknown, source: string): boolean {
  const parent = (functionNode as any)?.__doctorParent;
  if (!parent || parent.type !== "CallExpression") return false;
  const callee = getCalleeName(parent);
  if (!callee) return false;
  if (CLIENT_LIFECYCLE_CALLEES.has(callee) || CLIENT_EVENT_CALLEES.has(callee)) return true;
  if (callee.endsWith(".addEventListener")) return true;
  if (isNuxtClientHookCallback(functionNode, parent, source)) return true;

  const before = source.slice(Math.max(0, parent.start - 80), parent.start);
  return /@[\w:-]+\s*=|v-on:[\w:-]+\s*=/.test(before);
}

function isNuxtClientHookCallback(functionNode: unknown, call: unknown, source: string): boolean {
  const value = call as any;
  const callee = getCalleeName(value);
  if (!callee?.endsWith(".hook") && !callee?.endsWith(".hookOnce")) return false;
  if (value.arguments?.[1] !== functionNode) return false;
  const first = value.arguments?.[0];
  const hookName =
    first?.type === "Literal" && typeof first.value === "string"
      ? first.value
      : source.slice(first?.start ?? 0, first?.end ?? 0).replace(/^['"]|['"]$/g, "");
  return /^(app:mounted|page:loading:end|page:finish|page:transition:finish)$/.test(hookName);
}

function isComputedSetter(functionNode: unknown): boolean {
  const property = (functionNode as any)?.__doctorParent;
  if (property?.type !== "Property") return false;
  if ((property.key?.name ?? property.key?.value) !== "set") return false;
  const objectExpression = property.__doctorParent;
  const call = objectExpression?.__doctorParent;
  return objectExpression?.type === "ObjectExpression" && getCalleeName(call) === "computed";
}

function isClientOnlyObjectCallback(functionNode: unknown): boolean {
  const property = (functionNode as any)?.__doctorParent;
  const key = property?.key?.name ?? property?.key?.value;
  if (property?.type !== "Property" || key !== "handler") return false;
  return getDoctorParents(property).some((parent) => getCalleeName(parent) === "defineShortcuts");
}

function isDeferredCallback(functionNode: unknown): boolean {
  const parent = (functionNode as any)?.__doctorParent;
  if (!parent || parent.type !== "CallExpression") return false;
  const callee = getCalleeName(parent);
  return !!callee && DEFERRED_CALLBACK_CALLEES.has(callee);
}

function isReturnedComposableFunction(functionNode: unknown): boolean {
  const name = getFunctionLikeName(functionNode);
  if (!name) return false;
  const outer = getDoctorParents(functionNode).find((parent) => isFunctionLike(parent));
  const outerName = getFunctionLikeName(outer);
  if (!outerName?.startsWith("use")) return false;
  if (
    getDoctorParents(functionNode).some((parent) => {
      const value = parent as any;
      return (
        value?.type === "ReturnStatement" ||
        (value?.type === "Property" &&
          ((value.key?.name ?? value.key?.value) === name || value.value === functionNode))
      );
    })
  )
    return true;

  let returned = false;
  walkAst(outer, (node) => {
    const value = node as any;
    if (value?.type !== "ReturnStatement" || value.argument?.type !== "ObjectExpression") return;
    returned ||= value.argument.properties?.some((property: any) => {
      return (
        property?.type === "Property" &&
        ((property.key?.name ?? property.key?.value) === name ||
          (property.value?.type === "Identifier" && property.value.name === name))
      );
    });
  });
  return returned;
}

function isOnlyCalledFromClientOnlyContext(
  name: string,
  declaration: unknown,
  root: unknown,
  source: string,
): boolean {
  return isOnlyCalledFromClientOnlyContextInner(name, declaration, root, source, new Set());
}

function isOnlyCalledFromClientOnlyContextInner(
  name: string,
  declaration: unknown,
  root: unknown,
  source: string,
  seen: Set<string>,
): boolean {
  if (!root || typeof root !== "object") return false;
  if (seen.has(name)) return false;
  seen.add(name);
  const declarationNames = collectDeclarations(root);
  const declarationRange = getFunctionDeclarationRange(declaration);
  const calls: any[] = [];
  walkAst(root, (node) => {
    const value = node as any;
    if (value?.type === "CallExpression" && getCalleeName(node) === name) calls.push(node);
    if (
      value?.type === "Identifier" &&
      value.name === name &&
      !isInsideDeclaration(value, declaration) &&
      !isInsideRange(value, declarationRange) &&
      !declarationNames.has(value.name)
    )
      calls.push(value);
  });
  const externalCalls = calls.filter(
    (call) => !isInsideDeclaration(call, declaration) && !isInsideRange(call, declarationRange),
  );
  if (!externalCalls.length) return false;
  return externalCalls.every((call) => {
    if (isClientOnlyExecutionContext(call, source)) return true;
    const parent = (call as any).__doctorParent;
    const callee = parent?.type === "CallExpression" ? getCalleeName(parent) : null;
    if (
      callee &&
      TIMER_CALLBACK_CALLEES.has(callee) &&
      isClientOnlyExecutionContext(parent, source)
    )
      return true;
    const caller = getDoctorParents(call).find((parent) => isFunctionLike(parent));
    const callerName = getFunctionLikeName(caller);
    return (
      !!callerName && isOnlyCalledFromClientOnlyContextInner(callerName, caller, root, source, seen)
    );
  });
}

function collectDeclarations(root: unknown): Set<string> {
  const names = new Set<string>();
  walkAst(root, (node) => {
    const name = getDeclaredName(node);
    if (name) names.add(name);
  });
  return names;
}

function getDeclaredName(node: unknown): string | null {
  const value = node as any;
  if (value?.type === "FunctionDeclaration") return value.id?.name ?? null;
  if (value?.type === "VariableDeclarator" && value.id?.type === "Identifier") return value.id.name;
  if (value?.type === "Identifier") {
    const parent = value.__doctorParent;
    if (parent?.type === "FunctionDeclaration" && parent.id === value) return value.name;
    if (parent?.type === "VariableDeclarator" && parent.id === value) return value.name;
  }
  return null;
}

function isInsideDeclaration(node: unknown, declaration: unknown): boolean {
  let current = node as any;
  while (current && typeof current === "object") {
    if (current === declaration) return true;
    if (current.__doctorParent === declaration) return true;
    current = current.__doctorParent;
  }
  return false;
}

function getFunctionDeclarationRange(declaration: unknown): { start: number; end: number } | null {
  const node = declaration as any;
  if (typeof node?.start === "number" && typeof node?.end === "number")
    return { start: node.start, end: node.end };
  const parent = node?.__doctorParent;
  if (parent?.type === "VariableDeclarator") {
    const statement = parent.__doctorParent;
    if (typeof statement?.start === "number" && typeof statement?.end === "number")
      return { start: statement.start, end: statement.end };
  }
  return null;
}

function isInsideRange(node: unknown, range: { start: number; end: number } | null): boolean {
  const value = node as any;
  return (
    !!range &&
    typeof value?.start === "number" &&
    value.start >= range.start &&
    value.start <= range.end
  );
}

function walkAst(node: unknown, visit: (node: unknown) => void) {
  if (!node || typeof node !== "object") return;
  const typed = node as any;
  if (!typed.type) return;
  visit(typed);
  for (const key of visitorKeys[typed.type] ?? []) {
    const value = typed[key];
    if (Array.isArray(value)) {
      for (const child of value) walkAst(child, visit);
    } else if (value && typeof value === "object") {
      walkAst(value, visit);
    }
  }
}

function getFunctionLikeName(functionNode: unknown): string | null {
  const node = functionNode as any;
  if (!node || typeof node !== "object") return null;
  if (node.type === "FunctionDeclaration" && node.id?.type === "Identifier") return node.id.name;
  const parent = node.__doctorParent;
  if (parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier")
    return parent.id.name;
  if (
    parent?.type === "Property" &&
    (parent.key?.type === "Identifier" || parent.key?.type === "Literal")
  )
    return String(parent.key.name ?? parent.key.value);
  return null;
}

function getObjectPropertyKeyName(functionNode: unknown): string | null {
  const parent = (functionNode as any).__doctorParent;
  if (
    parent?.type === "Property" &&
    (parent.key?.type === "Identifier" || parent.key?.type === "Literal")
  )
    return String(parent.key.name ?? parent.key.value);
  return null;
}

function isTemplateEventHandlerReference(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:@|v-on:)[\\w:-]+\\s*=\\s*["'][^"']*\\b${escaped}\\b`).test(source);
}

function isTypeOnlyContext(node: unknown): boolean {
  return getDoctorParents(node).some((parent) => {
    const type = parent?.type;
    return (
      typeof type === "string" &&
      (type.startsWith("TS") ||
        type === "TypeAnnotation" ||
        type === "TypeAlias" ||
        type === "InterfaceDeclaration")
    );
  });
}

function hasLocalBindingBefore(node: unknown, source: string): boolean {
  const value = node as any;
  if (value?.type !== "Identifier" || typeof value.name !== "string") return false;
  const parent = value.__doctorParent;
  if (parent?.type === "VariableDeclarator" && parent.id === value) return true;
  if (parent?.type === "FunctionDeclaration" && parent.id === value) return true;
  if (parent?.type === "Property" && parent.key === value && !parent.computed) return true;

  const name = value.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const before = source.slice(0, value.start);
  return new RegExp(
    String.raw`(?:\b(?:const|let|var)\s+${name}\b|[,(]\s*${name}\s*(?::[^)=]+)?=>|\(\s*${name}\s*(?::[^)]*)?\)\s*=>|function[^(]*\([^)]*\b${name}\b|[,(]\s*\{[^)]*\b${name}\b[^)]*\}\s*(?::[^)=]+)?=>|function[^(]*\([^)]*\{[^)]*\b${name}\b)`,
  ).test(before);
}

function isTypeofOperand(node: unknown): boolean {
  const parent = (node as any)?.__doctorParent;
  return parent?.type === "UnaryExpression" && parent.operator === "typeof";
}

function getNodeName(node: unknown): string | null {
  const value = node as any;
  if (!value) return null;
  if (value.type === "Identifier") return value.name;
  if (value.type === "Literal") return String(value.value);
  if (value.type === "StaticMemberExpression" || value.type === "MemberExpression") {
    const object = getNodeName(value.object);
    const property = getNodeName(value.property);
    return object && property ? `${object}.${property}` : (object ?? property);
  }
  return null;
}

function getCalleeName(node: unknown): string | null {
  return getNodeName((node as any)?.callee);
}

function labelSeverity(severity: string): string {
  return severity === "blocker"
    ? "Blockers"
    : severity === "error"
      ? "Errors"
      : severity === "warn"
        ? "Warnings"
        : "Info";
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function nativeMatch(value: string, pattern: string): boolean {
  if (matchesGlob(value, pattern)) return true;
  return value === pattern || value.includes(pattern);
}
