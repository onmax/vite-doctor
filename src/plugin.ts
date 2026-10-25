import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { basename, isAbsolute, relative, resolve } from "pathe";
import type {
  DoctorConfig,
  DoctorExtensionInput,
  DoctorPluginApi,
  DoctorRunOptions,
} from "./core/index.js";
import {
  diffStates,
  formatDelta,
  mergeAffectedRun,
  stateFromRun,
  type DiagnosticState,
} from "./plugin-delta.js";
import type { SurfaceRunInput, SurfaceRunOutcome } from "./plugin-run.js";
import type { Plugin, ResolvedConfig, ViteDevServer } from "vite";

export interface ViteDoctorSurfaceOptions {
  enabled?: boolean;
  run?: "build" | "serve" | "both";
  mode?: "warn" | "error";
  root?: string;
  framework?: "auto" | "vite" | "vue" | "nitro" | "nuxt";
  config?: DoctorConfig;
  extends?: DoctorRunOptions["extends"];
  /** Explicit Doctor Extensions. Extensions exposed by other Vite plugins through `api.doctor` attach automatically. */
  extensions?: DoctorExtensionInput[];
  rules?: string;
  severity?: "error" | "warn" | "info";
  maxWarnings?: number;
  cache?: boolean;
  format?: DoctorRunOptions["format"];
}

export function doctor(options: ViteDoctorSurfaceOptions = {}): Plugin {
  let config: ResolvedConfig | undefined;
  let ran = false;
  let serveRun: ServeDoctorRun | undefined;

  return {
    name: "vite-doctor",
    configResolved(resolved) {
      config = resolved;
      ran = false;
    },
    configureServer(server) {
      if (options.enabled === false || !shouldRun(options.run ?? "build", "serve")) return;
      // Nuxt's serial dev builds pair the client dev server with an SSR-only companion server.
      if (server.config.build.ssr) return;
      serveRun?.cancel();
      serveRun = new ServeDoctorRun(server, options);
    },
    async buildStart() {
      if (options.enabled === false || ran) return;
      const resolved = config;
      if (!resolved || !shouldRun(options.run ?? "build", resolved.command)) return;

      if (resolved.command === "serve") {
        const run = serveRun;
        if (run?.server.config !== resolved) return;
        ran = true;
        run.startAfterListening();
        return;
      }
      ran = true;

      const { runSurfaceDoctor } = await import("./plugin-run.js");
      const outcome = await runSurfaceDoctor(
        surfaceRunInput(resolved, options),
        surfaceExtensions(resolved, options),
      );
      if (outcome.shouldFail && (options.mode ?? "error") === "error") {
        this.error(outcome.report || "Vite Doctor checks failed.");
        return;
      }
      if (!outcome.report) return;
      if (outcome.hasFindings) resolved.logger.warn(outcome.report);
      else resolved.logger.info(outcome.report);
    },
    closeBundle() {
      if (serveRun && this.environment?.getTopLevelConfig() === serveRun.server.config) {
        serveRun.cancel();
        serveRun = undefined;
      }
    },
  };
}

/**
 * A serve-mode Doctor Run belongs to one dev server and starts once that server listens, so it
 * never delays startup. Runs whose inputs can cross a thread boundary execute in a worker; Doctor
 * Extension objects cannot, so those runs stay on the main thread after listening.
 *
 * After the first run logs its report, saved source files rerun Doctor with them as
 * `affectedFiles`, and only the Diagnostics that changed are logged. The dev server watcher is
 * shared by every Vite environment and fires even with HMR off, so a save reruns Doctor once,
 * where `hotUpdate` would fire per environment.
 */
class ServeDoctorRun {
  private closed = false;
  private state: DiagnosticState | undefined;
  private active: ActiveRun | undefined;
  private pending = emptyChanges();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly onFileEvent = (file: string) => this.fileChanged(file);

  constructor(
    readonly server: ViteDevServer,
    private readonly options: ViteDoctorSurfaceOptions,
  ) {}

  startAfterListening() {
    const { middlewareMode } = this.server.config.server;
    const host =
      this.server.httpServer ??
      (typeof middlewareMode === "object" ? middlewareMode.server : undefined);
    const start = () =>
      setImmediate(() => {
        if (this.closed) return;
        for (const event of WATCHED_EVENTS) this.server.watcher.on(event, this.onFileEvent);
        void this.execute({ changed: [] }, true);
      });
    if (host && !host.listening) host.once("listening", start);
    else start();
  }

  cancel() {
    this.closed = true;
    clearTimeout(this.timer);
    for (const event of WATCHED_EVENTS) this.server.watcher.off(event, this.onFileEvent);
    this.active?.stop();
  }

  private fileChanged(path: string) {
    const file = resolve(path);
    const kind = hotUpdateKind(surfaceRoot(this.server.config, this.options), this.options, file);
    if (!kind) return;
    if (kind === "inventory") this.pending.full = true;
    else this.pending.files.add(file);
    this.pending.changed.add(file);
    // A rerun that has not reported yet would miss this save, so it restarts with it.
    const active = this.active;
    if (active && !active.initial && !active.stale) {
      if (active.affected) {
        for (const affected of active.affected) this.pending.files.add(affected);
      } else this.pending.full = true;
      for (const changed of active.changed) this.pending.changed.add(changed);
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
    const { files, full, changed } = this.pending;
    this.pending = emptyChanges();
    // Without a recorded run there is nothing an affected-files run could be compared with.
    const affected = full || !this.state ? undefined : files;
    await this.execute({ affected, changed: [...changed] });
  }

  private async execute(batch: RunBatch, initial = false) {
    const { config } = this.server;
    const base = surfaceRunInput(config, this.options);
    const input: SurfaceRunInput = batch.affected
      ? { ...base, options: { ...base.options, affectedFiles: [...batch.affected] } }
      : base;
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
  options: ViteDoctorSurfaceOptions,
  file: string,
): "source" | "inventory" | undefined {
  if (!isInside(root, file)) return undefined;
  if (
    relative(root, file)
      .split("/")
      .some((name) => IGNORED_DIRECTORIES.has(name))
  )
    return undefined;
  // Doctor writes its cache during a run, which must not schedule another run.
  if (isInside(resolve(root, options.config?.cache?.dir ?? ".vite-doctor/cache"), file))
    return undefined;
  if (basename(file) === "package.json") return "inventory";
  return SOURCE_FILE.test(file) ? "source" : undefined;
}

function isInside(directory: string, file: string): boolean {
  const path = relative(directory, file);
  return path !== "" && !path.startsWith("../") && path !== ".." && !isAbsolute(path);
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

function surfaceRunInput(config: ResolvedConfig, options: ViteDoctorSurfaceOptions) {
  return {
    options: {
      root: surfaceRoot(config, options),
      framework: options.framework ?? "auto",
      config: options.config,
      extends: options.extends,
      rules: options.rules,
      severity: options.severity,
      maxWarnings: options.maxWarnings,
      cache: options.cache ?? true,
      format: options.format,
    },
    vite: { inventory: viteInventory(config), evidence: viteRuntimeEvidence(config) },
  } satisfies SurfaceRunInput;
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

function viteRuntimeEvidence(config: ResolvedConfig) {
  const prefixes = config.envPrefix ?? "VITE_";
  const environments = Object.values(config.environments ?? {});
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
  return {
    buildSsr: Boolean(config.build?.ssr),
    ssrExternal: config.ssr?.external ?? [],
    ssrNoExternal: config.ssr?.noExternal ?? [],
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
