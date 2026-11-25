import { existsSync } from "node:fs";
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { basename, dirname, isAbsolute, relative, resolve } from "pathe";
import type {
  DoctorConfig,
  DoctorExtensionInput,
  DoctorPluginApi,
  DoctorRunOptions,
  DoctorSerializableConfig,
} from "./core/index.js";
import {
  diffStates,
  formatDelta,
  mergeAffectedRun,
  stateFromRun,
  type DiagnosticState,
} from "./plugin-delta.js";
import type { McpServerTarget } from "./mcp/evidence.js";
import type { SurfaceRunInput, SurfaceRunOutcome } from "./plugin-run.js";
import { RuntimeDiagnosticReports } from "./plugin-runtime-diagnostics.js";
import {
  buildDiagnosticFingerprint,
  buildModuleFile,
  wantsBuildEvidence,
  type ViteBuildEvidence,
} from "./rule-packs/vite/rules/build-evidence.js";
import type { BuildEnvironment, Plugin, ResolvedConfig, ViteDevServer } from "vite";

type BuildTarget = Pick<BuildEnvironment, "name" | "config">;

function newBuildReports() {
  return {
    pending: Promise.resolve(),
    reported: new Set<string>(),
    warnings: new Set<string>(),
  };
}

export interface ViteDoctorSurfaceOptions {
  enabled?: boolean;
  run?: "build" | "serve" | "both";
  mode?: "warn" | "error";
  root?: string;
  framework?: "auto" | "vite" | "vue" | "nitro" | "nuxt";
  /** Doctor config for this plugin. When unset, the plugin uses the `doctor` key of the Vite config. */
  config?: DoctorConfig;
  extends?: DoctorRunOptions["extends"];
  /** Explicit Doctor Extensions. Extensions exposed by other Vite plugins through `api.doctor` attach automatically. */
  extensions?: DoctorExtensionInput[];
  rules?: string;
  /** Report only Diagnostics on lines changed since the merge base with this Git ref, like `--since`. */
  since?: string;
  /** Report only Diagnostics on lines changed against `HEAD`, untracked files included, like `--changed`. */
  changed?: boolean;
  severity?: "error" | "warn" | "info";
  maxWarnings?: number;
  cache?: boolean;
  format?: DoctorRunOptions["format"];
  /**
   * MCP servers whose `tools/list` the Doctor Run reads as Runtime Evidence. In dev, a path such
   * as `/mcp` resolves against this dev server once it listens. A build has no server to resolve
   * it against, and neither does Nuxt, which runs Vite in middleware mode: pass an absolute URL.
   */
  mcp?: McpServerTarget[];
}

// vite-plus types its defineConfig() against its own copy of Vite, so the key only type-checks
// there when the project's `vite` resolves to that copy. scripts/test-packed-cli.mjs covers both.
declare module "vite" {
  interface UserConfig {
    /**
     * Doctor config for this project. The `vite-doctor` CLI reads it without running vite.config,
     * so keep it a literal, optionally wrapped in `defineDoctorConfig()`. The `doctor()` plugin
     * uses it when its own `config` option is not set.
     */
    doctor?: DoctorSerializableConfig;
  }
}

export function doctor(options: ViteDoctorSurfaceOptions = {}): Plugin {
  let config: ResolvedConfig | undefined;
  let ran = false;
  let serveRun: ServeDoctorRun | undefined;
  let buildReports = newBuildReports();
  const watchReports = new WeakMap<BuildTarget, ReturnType<typeof newBuildReports>>();
  let privateMaps = new WeakSet<object>();
  let stubResolutions = new WeakMap<object, Map<string, string>>();
  const inspectBuild =
    options.enabled !== false &&
    shouldRun(options.run ?? "build", "build") &&
    wantsBuildEvidence(options.rules);
  const checkedTargets = new WeakSet<BuildTarget>();
  const warningBudgets = new WeakMap<Plugin, Set<string>>();

  function sessionPlugin(resolved: ResolvedConfig) {
    return (
      resolved.environments && resolved.plugins.find((candidate) => warningBudgets.has(candidate))
    );
  }

  async function checkBuild(
    resolved: ResolvedConfig,
    fail: (message: string) => never,
    targets?: BuildTarget[],
    warnings?: Set<string>,
  ) {
    const { runSurfaceDoctor } = await import("./plugin-run.js");
    const outcome = await runSurfaceDoctor(
      surfaceRunInput(resolved, options, targets),
      surfaceExtensions(resolved, options),
    );
    reportBuild(resolved, outcome, fail, warnings);
  }

  function reportBuild(
    resolved: ResolvedConfig,
    outcome: SurfaceRunOutcome,
    fail: (message: string) => never,
    warnings?: Set<string>,
  ) {
    const maxWarnings = options.maxWarnings;
    const session = maxWarnings === undefined ? undefined : sessionPlugin(resolved);
    const sessionWarnings = warnings ?? (session && warningBudgets.get(session));
    if (sessionWarnings) for (const warning of outcome.warningKeys) sessionWarnings.add(warning);
    const overBudget =
      sessionWarnings && maxWarnings !== undefined && sessionWarnings.size > maxWarnings;
    if ((outcome.shouldFail || overBudget) && (options.mode ?? "error") === "error") {
      fail(outcome.report || "Vite Doctor checks failed.");
    } else if (outcome.report) {
      if (outcome.hasFindings) resolved.logger.warn(outcome.report);
      else resolved.logger.info(outcome.report);
    }
  }

  const buildApp = {
    order: "post",
    async handler(builder) {
      if (options.enabled === false || !shouldRun(options.run ?? "build", "build")) return;
      const targets = Object.values(builder.environments);
      const configuredPlugin = sessionPlugin(builder.config) ?? plugin;
      if (
        targets.length === 0 ||
        targets.some(
          (target) =>
            target.config.build.watch ||
            target.isBuilt !== false ||
            !target.plugins.includes(configuredPlugin),
        ) ||
        builder.config.plugins.some((plugin) => plugin.buildApp && plugin.buildApp !== buildApp)
      )
        return;
      await checkBuild(builder.config, (message) => this.error(message), targets);
      for (const target of targets) checkedTargets.add(target);
    },
  } satisfies NonNullable<Plugin["buildApp"]>;

  const plugin: Plugin = {
    name: "vite-doctor",
    sharedDuringBuild: options.maxWarnings !== undefined,
    configResolved(resolved) {
      config = resolved;
      ran = false;
      buildReports = newBuildReports();
      privateMaps = new WeakSet();
      stubResolutions = new WeakMap();
      if (
        resolved.command !== "build" ||
        options.maxWarnings === undefined ||
        !resolved.environments
      )
        return;
      const plugins = resolved.plugins as Plugin[];
      const index = plugins.indexOf(plugin);
      if (index < 0) return;
      const session = Object.create(
        Object.getPrototypeOf(plugin),
        Object.getOwnPropertyDescriptors(plugin),
      ) as Plugin;
      warningBudgets.set(session, new Set());
      plugins[index] = session;
    },
    configureServer(server) {
      if (options.enabled === false || !shouldRun(options.run ?? "build", "serve")) return;
      // Nuxt's serial dev builds pair the client dev server with an SSR-only companion server.
      if (server.config.build.ssr) return;
      serveRun?.cancel();
      serveRun = new ServeDoctorRun(server, options);
    },
    async buildStart() {
      const target = this.environment;
      if (options.enabled === false) return;
      const resolved = target?.getTopLevelConfig() ?? config;
      if (!resolved || !shouldRun(options.run ?? "build", resolved.command)) return;

      if (resolved.command === "serve") {
        const run = serveRun;
        if (ran || run?.server.config !== resolved) return;
        ran = true;
        run.startAfterListening();
        return;
      }
      if (target && this.meta.watchMode) {
        const reports = newBuildReports();
        watchReports.set(target, reports);
        await checkBuild(resolved, (message) => this.error(message), [target], reports.warnings);
        return;
      }
      if (target ? checkedTargets.has(target) : ran) return;
      await checkBuild(resolved, (message) => this.error(message), target ? [target] : undefined);
      if (target) checkedTargets.add(target);
      else ran = true;
    },
    resolveId: {
      order: "pre",
      async handler(source, importer, context) {
        const env = this.environment;
        if (
          !inspectBuild ||
          !this.meta.rolldownVersion ||
          env?.config.consumer !== "client" ||
          env.config.command !== "build" ||
          !importer ||
          !isBuiltin(source)
        )
          return;
        const resolution = await this.resolve(source, importer, { ...context, skipSelf: true });
        if (resolution && !resolution.external) {
          let resolutions = stubResolutions.get(env);
          if (!resolutions) stubResolutions.set(env, (resolutions = new Map()));
          resolutions.set(`${importer}\0${source}`, resolution.id);
        }
        return resolution;
      },
    },
    outputOptions: {
      order: "post",
      handler(output) {
        const env = this.environment;
        if (
          !inspectBuild ||
          !this.meta.rolldownVersion ||
          this.meta.watchMode ||
          env?.config.consumer !== "client" ||
          output.sourcemap ||
          (output.plugins && !(Array.isArray(output.plugins) && output.plugins.length === 0)) ||
          env.plugins.findLast(
            ({ outputOptions }) =>
              typeof outputOptions === "object" && outputOptions.order === "post",
          )?.outputOptions !== plugin.outputOptions
        )
          return;
        privateMaps.add(env);
        return { ...output, sourcemap: "hidden" };
      },
    },
    generateBundle: {
      order: "post",
      async handler(output, bundle) {
        if (!inspectBuild || !this.meta.rolldownVersion) return;
        const env = this.environment;
        if (env?.config.consumer !== "client") return;
        const resolved = env.getTopLevelConfig();
        const { collectBuildEnvironment } = await import("./plugin-build-evidence.js");
        const { environment, missingMapIds } = collectBuildEnvironment(
          this,
          output,
          bundle,
          resolved.root,
          env.name,
          privateMaps.delete(env) && output.sourcemap === "hidden",
          stubResolutions.get(env),
        );
        if (!environment.browserStubReads.length && !missingMapIds.size) return;

        const watch = watchReports.get(env);
        const reports = watch ?? buildReports;
        return (reports.pending = reports.pending.then(async () => {
          const evidence = { root: resolved.root, environments: [environment] };
          const extensions = surfaceExtensions(resolved, options);
          const { hasEnabledBuildEvidenceCandidate, runBuildEvidenceDoctor } =
            await import("./plugin-run.js");
          if (
            missingMapIds.size &&
            (await hasEnabledBuildEvidenceCandidate(
              surfaceRunInput(resolved, options, undefined, evidence),
              extensions,
              missingMapIds,
            ))
          ) {
            resolved.logger.warnOnce(
              `[vite-doctor] VITE0033 verification skipped for client output in ${env.name}: ` +
                'source maps are unavailable. Set build.sourcemap: "hidden" to enable verification.',
            );
          }
          const doctorRoot = surfaceRoot(resolved, options);
          environment.browserStubReads = environment.browserStubReads.filter(({ id }) => {
            const file = buildModuleFile(evidence, id);
            return (
              file &&
              !reports.reported.has(
                buildDiagnosticFingerprint(relative(doctorRoot, file), env.name),
              )
            );
          });
          if (!environment.browserStubReads.length) return;
          const outcome = await runBuildEvidenceDoctor(
            surfaceRunInput(resolved, options, undefined, evidence),
            extensions,
          );
          if (!outcome.diagnostics.length) return;
          for (const diagnostic of outcome.diagnostics) reports.reported.add(diagnostic.id);
          reportBuild(resolved, outcome, (message) => this.error(message), watch?.warnings);
        }));
      },
    },
    buildApp,
    closeBundle() {
      if (serveRun && this.environment?.getTopLevelConfig() === serveRun.server.config) {
        serveRun.cancel();
        serveRun = undefined;
      }
    },
  };
  return plugin;
}

/**
 * A serve-mode Doctor Run belongs to one dev server and starts once that server listens, so it
 * never delays startup. Runs whose inputs can cross a thread boundary execute in a worker; Doctor
 * Extension objects cannot, so those runs stay on the main thread after listening.
 *
 * After the first report, saves rerun Doctor on `affectedFiles` or refresh the whole Git-scoped
 * report. Only the Diagnostics that changed are logged. The dev server watcher is
 * shared by every Vite environment and fires even with HMR off, so a save reruns Doctor once,
 * where `hotUpdate` would fire per environment.
 *
 * Framework diagnostics that browser clients report over the HMR channel join every later run as
 * Runtime Evidence, and a new one reruns its file, or the whole project when it has no file.
 */
class ServeDoctorRun {
  private closed = false;
  private state: DiagnosticState | undefined;
  private active: ActiveRun | undefined;
  private pending = emptyChanges();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly onFileEvent = (file: string) => this.fileChanged(file);
  private readonly runtimeDiagnostics: RuntimeDiagnosticReports;

  constructor(
    readonly server: ViteDevServer,
    private readonly options: ViteDoctorSurfaceOptions,
  ) {
    this.runtimeDiagnostics = new RuntimeDiagnosticReports(server, (report) =>
      this.runtimeDiagnosticReported(report.location?.file),
    );
  }

  startAfterListening() {
    const { middlewareMode } = this.server.config.server;
    const host =
      this.server.httpServer ??
      (typeof middlewareMode === "object" ? middlewareMode.server : undefined);
    const start = () =>
      setImmediate(() => {
        if (this.closed) return;
        this.server.watcher.add(packageInputs(surfaceRoot(this.server.config, this.options)));
        for (const event of WATCHED_EVENTS) this.server.watcher.on(event, this.onFileEvent);
        this.runtimeDiagnostics.listen();
        void this.execute({ changed: [] }, true);
      });
    if (host && !host.listening) host.once("listening", start);
    else start();
  }

  cancel() {
    this.closed = true;
    clearTimeout(this.timer);
    for (const event of WATCHED_EVENTS) this.server.watcher.off(event, this.onFileEvent);
    this.runtimeDiagnostics.close();
    this.active?.stop();
  }

  private fileChanged(path: string) {
    const file = resolve(path);
    const forgot = this.runtimeDiagnostics.forget(file);
    const kind = this.hotUpdateKind(file);
    if (!kind) {
      if (forgot) this.schedule(undefined);
      return;
    }
    this.pending.changed.add(file);
    this.schedule(kind === "source" ? file : undefined);
  }

  private runtimeDiagnosticReported(file: string | undefined) {
    this.pending.reported = true;
    this.schedule(file && this.hotUpdateKind(file) === "source" ? file : undefined);
  }

  private hotUpdateKind(file: string) {
    return hotUpdateKind(
      surfaceRoot(this.server.config, this.options),
      surfaceConfig(this.server.config, this.options),
      file,
    );
  }

  /** Queues a rerun of `file`, or of the whole project without one. */
  private schedule(file: string | undefined) {
    if (file) this.pending.files.add(file);
    else this.pending.full = true;
    // A rerun that has not reported yet would miss this save, so it restarts with it.
    const active = this.active;
    if (active && !active.initial && !active.stale) {
      if (active.affected) {
        for (const affected of active.affected) this.pending.files.add(affected);
      } else this.pending.full = true;
      for (const changed of active.changed) this.pending.changed.add(changed);
      if (active.reported) this.pending.reported = true;
      active.stop();
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), HOT_UPDATE_DEBOUNCE_MS);
  }

  private async flush() {
    this.timer = undefined;
    // A main-thread run cannot be interrupted, so the next run waits for it instead of stacking.
    if (this.active) await this.active.done;
    if (this.closed || this.timer || this.active) return;
    const { files, full, changed, reported } = this.pending;
    this.pending = emptyChanges();
    // A Git-scoped run cannot prove a Diagnostic disappeared by checking only saved files, and
    // neither can a run that rereads MCP servers, whose gaps and Diagnostics have no saved file.
    const affected =
      full || !this.state || this.options.changed || this.options.since || this.options.mcp?.length
        ? undefined
        : files;
    await this.execute({ affected, changed: [...changed], reported });
  }

  private async execute(batch: RunBatch, initial = false) {
    const { config } = this.server;
    let base: ReturnType<typeof surfaceRunInput>;
    try {
      base = surfaceRunInput(config, this.options, undefined, undefined, this.server);
    } catch (error) {
      config.logger.error(
        `Vite Doctor could not start the Doctor Run: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    const input: SurfaceRunInput = batch.affected
      ? { ...base, options: { ...base.options, affectedFiles: [...batch.affected] } }
      : base;
    input.frameworkDiagnostics = this.runtimeDiagnostics.list();
    const extensions = surfaceExtensions(config, this.options);
    const done = Promise.withResolvers<void>();
    const run: ActiveRun = {
      ...batch,
      initial,
      stale: false,
      done: done.promise,
      stop() {
        run.stale = true;
        void run.worker?.terminate();
      },
    };
    this.active = run;
    let outcome: SurfaceRunOutcome | undefined;
    try {
      outcome = canRunInWorker(input, extensions)
        ? await this.runInWorker(input, run)
        : await import("./plugin-run.js").then(({ runSurfaceDoctor }) =>
            runSurfaceDoctor(input, extensions),
          );
    } catch (error) {
      if (!run.stale && !this.closed) {
        const message = error instanceof Error ? error.message : String(error);
        config.logger.error(`Vite Doctor could not finish the Doctor Run: ${message}`, {
          error: error instanceof Error ? error : undefined,
        });
      }
    } finally {
      if (this.active === run) this.active = undefined;
      done.resolve();
    }
    if (outcome && !run.stale && !this.closed) this.record(base.options.root, batch, outcome);
  }

  private record(root: string, batch: RunBatch, outcome: SurfaceRunOutcome) {
    const previous = this.state;
    const next =
      previous && batch.affected
        ? mergeAffectedRun(previous, batch.affected, outcome)
        : stateFromRun(outcome);
    this.state = next;
    if (!previous) {
      this.logReport(outcome);
      return;
    }
    const log = formatDelta(diffStates(previous, next), next, {
      root,
      changed: batch.changed,
      reported: batch.reported,
      mode: this.options.mode ?? "error",
      maxWarnings: this.options.maxWarnings,
    });
    if (log) this.server.config.logger[log.level](log.message);
  }

  private runInWorker(input: SurfaceRunInput, run: ActiveRun) {
    return new Promise<SurfaceRunOutcome | undefined>((resolvePromise, reject) => {
      const worker = new Worker(workerUrl, { workerData: input });
      run.worker = worker;
      worker.unref();
      worker.once("message", (message: { outcome?: SurfaceRunOutcome; error?: string }) => {
        if (message.error !== undefined) reject(new Error(message.error));
        else resolvePromise(message.outcome);
      });
      worker.once("error", reject);
      worker.once("exit", () => resolvePromise(undefined));
    });
  }

  private logReport(outcome: SurfaceRunOutcome) {
    const { logger } = this.server.config;
    if (!outcome.report) return;
    if (outcome.shouldFail && (this.options.mode ?? "error") === "error")
      logger.error(outcome.report);
    else if (outcome.hasFindings) logger.warn(outcome.report);
    else logger.info(outcome.report);
  }
}

interface RunBatch {
  /** Files the run reports, or undefined for a full Doctor Run. */
  affected?: ReadonlySet<string>;
  /** Files whose change started the run. */
  changed: string[];
  /** A framework diagnostic reported at runtime started the run. */
  reported?: boolean;
}

interface ActiveRun extends RunBatch {
  initial: boolean;
  stale: boolean;
  worker?: Worker;
  done: Promise<void>;
  stop(): void;
}

function emptyChanges() {
  return {
    files: new Set<string>(),
    /** A changed file feeds Project Inventory for every file, so the next run is a full run. */
    full: false,
    changed: new Set<string>(),
    reported: false,
  };
}

const WATCHED_EVENTS = ["add", "change", "unlink"] as const;
const HOT_UPDATE_DEBOUNCE_MS = 100;
const SOURCE_FILE = /\.(?:vue|[cm]?[jt]sx?|mdc?)$/;
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git"]);

/**
 * A saved source file reruns Doctor for itself. A package manifest feeds Project Inventory and
 * manifest Rules, so it reruns the whole project. Other files are not Doctor Run input.
 */
function hotUpdateKind(
  root: string,
  config: DoctorConfig | undefined,
  file: string,
): "source" | "inventory" | undefined {
  if (packageInputs(root).includes(file)) return "inventory";
  if (!isInside(root, file)) return undefined;
  if (
    relative(root, file)
      .split("/")
      .some((name) => IGNORED_DIRECTORIES.has(name))
  )
    return undefined;
  // Doctor writes its cache during a run, which must not schedule another run.
  if (isInside(resolve(root, config?.cache?.dir ?? ".vite-doctor/cache"), file)) return undefined;
  if (basename(file) === "package.json") return "inventory";
  return SOURCE_FILE.test(file) ? "source" : undefined;
}

function isInside(directory: string, file: string): boolean {
  const path = relative(directory, file);
  return path !== "" && !path.startsWith("../") && path !== ".." && !isAbsolute(path);
}

function packageInputs(root: string): string[] {
  for (let directory = root; ; directory = dirname(directory)) {
    if (existsSync(resolve(directory, "pnpm-workspace.yaml"))) {
      return [resolve(directory, "pnpm-workspace.yaml"), resolve(directory, "pnpm-lock.yaml")];
    }
    if (dirname(directory) === directory)
      return [resolve(root, "pnpm-workspace.yaml"), resolve(root, "pnpm-lock.yaml")];
  }
}

const workerUrl = new URL("./plugin-worker.mjs", import.meta.url);

function canRunInWorker(input: SurfaceRunInput, extensions: DoctorExtensionInput[]) {
  if (extensions.length > 0 || !existsSync(fileURLToPath(workerUrl))) return false;
  try {
    structuredClone(input);
    return true;
  } catch {
    return false;
  }
}

function surfaceRoot(config: ResolvedConfig, options: ViteDoctorSurfaceOptions) {
  return options.root ? resolve(config.root, options.root) : config.root;
}

function surfaceConfig(
  config: ResolvedConfig,
  options: ViteDoctorSurfaceOptions,
): DoctorConfig | undefined {
  return options.config ?? config.doctor;
}

function surfaceRunInput(
  config: ResolvedConfig,
  options: ViteDoctorSurfaceOptions,
  targets?: BuildTarget[],
  build?: ViteBuildEvidence,
  devServer?: ViteDevServer,
) {
  return {
    options: {
      root: surfaceRoot(config, options),
      framework: options.framework ?? "auto",
      config: surfaceConfig(config, options),
      extends: options.extends,
      rules: options.rules,
      since: options.since,
      changed: options.changed,
      severity: options.severity,
      maxWarnings: options.maxWarnings,
      cache: options.cache ?? true,
      format: options.format,
      mcp: options.mcp && surfaceMcpTargets(options.mcp, devServer),
    },
    vite: {
      inventory: viteInventory(config),
      evidence: { ...viteRuntimeEvidence(config, targets), ...(build ? { build } : {}) },
    },
  } satisfies SurfaceRunInput;
}

/** Resolves a path such as `/mcp` against the dev server that serves it. */
function surfaceMcpTargets(
  targets: readonly McpServerTarget[],
  devServer: ViteDevServer | undefined,
): McpServerTarget[] {
  return targets.map((target) => {
    if (URL.canParse(target.url)) return target;
    const local = devServer?.resolvedUrls?.local[0];
    if (local) return { ...target, url: new URL(target.url, local).href };
    const reason = !devServer
      ? "a build has no dev server to resolve it against"
      : "this dev server runs in middleware mode, as under Nuxt, so Vite does not know its URL";
    throw new Error(
      `MCP server URL ${JSON.stringify(target.url)} is a path, and ${reason}. Pass an absolute URL in the mcp option, such as http://localhost:3000/mcp.`,
    );
  });
}

function surfaceExtensions(
  config: ResolvedConfig,
  options: ViteDoctorSurfaceOptions,
): DoctorExtensionInput[] {
  return [...(options.extensions ?? []), ...hostPluginExtensions(config)];
}

function hostPluginExtensions(config: ResolvedConfig): DoctorExtensionInput[] {
  return (config.plugins ?? []).flatMap((plugin) => {
    const api = (plugin.api as { doctor?: Partial<DoctorPluginApi> } | undefined)?.doctor;
    return Array.isArray(api?.extensions) ? api.extensions : [];
  });
}

function viteInventory(config: ResolvedConfig) {
  return {
    root: config.root,
    command: config.command,
    mode: config.mode,
    base: config.base,
    publicDir: config.publicDir,
    envDir: config.envDir,
    aliases: (config.resolve?.alias ?? []).map(({ find, replacement }) => ({ find, replacement })),
    plugins: config.plugins?.map((plugin) => plugin.name).filter(Boolean) ?? [],
  };
}

function viteRuntimeEvidence(config: ResolvedConfig, targets?: BuildTarget[]) {
  const prefixes = config.envPrefix ?? "VITE_";
  const namedEnvironments = Object.entries(config.environments ?? {});
  const environments = namedEnvironments.map(([, environment]) => environment);
  const hasResolvedConsumers = environments.every(
    ({ consumer }) => consumer === "client" || consumer === "server",
  );
  const defineKeys = [
    ...new Set([
      ...Object.keys(config.define ?? {}),
      ...environments
        .filter(({ consumer }) => consumer === "client")
        .flatMap((environment) => Object.keys(environment.define ?? {})),
    ]),
  ];
  const importEnvironments = targets
    ? targets.map(({ name, config }) => [name, config] as const)
    : namedEnvironments;
  const importResolution = Object.fromEntries(
    importEnvironments.map(([name, { consumer, resolve }]) => [
      name,
      { consumer, extensions: resolve.extensions },
    ]),
  );
  const extensions = config.resolve?.extensions;
  if (!importEnvironments.length && extensions) {
    if (config.command === "serve" || !config.build?.ssr) {
      importResolution.client = { consumer: "client", extensions };
    }
    if (config.command === "serve" || config.build?.ssr) {
      importResolution.ssr = { consumer: "server", extensions };
    }
  }
  return {
    buildSsr: Boolean(config.build?.ssr),
    clientHmr:
      config.command === "serve" && config.server
        ? { root: config.root, enabled: config.server.hmr !== false }
        : undefined,
    ssrExternal: config.ssr?.external ?? [],
    ssrNoExternal: config.ssr?.noExternal ?? [],
    importResolution: {
      root: config.root,
      environments: importResolution,
    },
    envExposure: hasResolvedConsumers
      ? {
          root: config.root,
          prefixes: typeof prefixes === "string" ? [prefixes] : [...prefixes],
          defineKeys: defineKeys
            .filter((key) => key.startsWith("import.meta.env."))
            .map((key) => key.slice("import.meta.env.".length)),
          hasObjectDefine:
            defineKeys.includes("import.meta.env") || defineKeys.includes("import.meta"),
        }
      : undefined,
  };
}

function shouldRun(run: NonNullable<ViteDoctorSurfaceOptions["run"]>, command: "build" | "serve") {
  if (run === "both") return true;
  return run === command;
}
