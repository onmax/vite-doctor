import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { resolve } from "pathe";
import type {
  DoctorConfig,
  DoctorExtensionInput,
  DoctorPluginApi,
  DoctorRunOptions,
} from "./core/index.js";
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
 */
class ServeDoctorRun {
  private cancelled = false;
  private worker: Worker | undefined;

  constructor(
    readonly server: ViteDevServer,
    private readonly options: ViteDoctorSurfaceOptions,
  ) {}

  startAfterListening() {
    const { middlewareMode } = this.server.config.server;
    const host =
      this.server.httpServer ??
      (typeof middlewareMode === "object" ? middlewareMode.server : undefined);
    const start = () => setImmediate(() => void this.run());
    if (host && !host.listening) host.once("listening", start);
    else start();
  }

  cancel() {
    this.cancelled = true;
    void this.worker?.terminate();
    this.worker = undefined;
  }

  private async run() {
    if (this.cancelled) return;
    const { config } = this.server;
    const input = surfaceRunInput(config, this.options);
    const extensions = surfaceExtensions(config, this.options);
    try {
      const outcome = canRunInWorker(input, extensions)
        ? await this.runInWorker(input)
        : await import("./plugin-run.js").then(({ runSurfaceDoctor }) =>
            runSurfaceDoctor(input, extensions),
          );
      if (!this.cancelled && outcome) this.log(outcome);
    } catch (error) {
      if (this.cancelled) return;
      const message = error instanceof Error ? error.message : String(error);
      config.logger.error(`Vite Doctor could not finish the Doctor Run: ${message}`, {
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  private runInWorker(input: SurfaceRunInput) {
    return new Promise<SurfaceRunOutcome | undefined>((resolvePromise, reject) => {
      const worker = new Worker(workerUrl, { workerData: input });
      this.worker = worker;
      worker.unref();
      worker.once("message", (message: { outcome?: SurfaceRunOutcome; error?: string }) => {
        if (message.error !== undefined) reject(new Error(message.error));
        else resolvePromise(message.outcome);
      });
      worker.once("error", reject);
      worker.once("exit", () => resolvePromise(undefined));
    });
  }

  private log(outcome: SurfaceRunOutcome) {
    const { logger } = this.server.config;
    if (!outcome.report) return;
    if (outcome.shouldFail && (this.options.mode ?? "error") === "error")
      logger.error(outcome.report);
    else if (outcome.hasFindings) logger.warn(outcome.report);
    else logger.info(outcome.report);
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

function surfaceRunInput(config: ResolvedConfig, options: ViteDoctorSurfaceOptions) {
  return {
    options: {
      root: options.root ? resolve(config.root, options.root) : config.root,
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
