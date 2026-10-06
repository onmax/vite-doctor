import { existsSync, readFileSync, statSync } from "node:fs";
import { cac } from "cac";
import { consola } from "consola";
import { dirname, relative, resolve } from "pathe";
import { fileURLToPath } from "node:url";
import {
  createReport,
  createRulesReport,
  explainRule,
  loadDoctorConfig,
  reportStatus,
  type CacheStatus,
  type DoctorConfig,
  type DoctorReportFormat,
  type DoctorRunOptions,
} from "./core/index.js";
import { selectDoctorPresentation } from "./core/internal/agent-runtime.js";
import { applyDoctorOptions, stringFlag } from "./core/internal/cli.js";
import type { DoctorProcessStatus } from "./doctor-process/client.js";
import { DOCTOR_PROCESS_ENV } from "./doctor-process/protocol.js";
import { viteDoctorVersion } from "./version.js";

type MetadataReportFormat = Exclude<DoctorReportFormat, "sarif">;

const removedCommands = new Set(["run", "ci", "scan", "check"]);
const reportFormats = new Set<DoctorReportFormat>(["text", "json", "sarif", "agent"]);
const metadataFormats = new Set<MetadataReportFormat>(["text", "json", "agent"]);
const frameworks = new Set<NonNullable<DoctorRunOptions["framework"]>>([
  "auto",
  "vite",
  "vue",
  "nitro",
  "nuxt",
]);
const severities = new Set<NonNullable<DoctorRunOptions["severity"]>>(["error", "warn", "info"]);
const analyses = new Set(["dead-code", "graph", "dupes", "health"]);

class CliConfigError extends Error {
  constructor(
    readonly file: string,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface CliSurfaceOptions {
  /** Trust Doctor Extension entries registered by the host, as the Nuxt Doctor Command does. */
  hostExtensions?: boolean;
}

export async function main(
  args = process.argv.slice(2),
  cwd = process.cwd(),
  surface: CliSurfaceOptions = {},
): Promise<number> {
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`${viteDoctorVersion}\n`);
    return 0;
  }

  if (removedCommands.has(args[0] ?? "")) {
    const command = args[0]!;
    const replacement =
      command === "scan" || command === "check"
        ? "vite-doctor [path]"
        : "your package manager scripts";
    await writeCliError(
      `vite-doctor ${command} was removed. Use ${replacement}.`,
      await requestedPresentation(args),
    );
    return 2;
  }

  let exitCode = 0;
  const cli = cac("vite-doctor");
  addDoctorRunCommand(cli, args, cwd, surface, (code) => (exitCode = code));
  cli
    .command("migrate [path]", "Evaluate source against a future runtime graph.")
    .option("--to <target>", "Explicit target such as nuxt@5 or nitro@3.")
    .option("--format <format>", "Output: text, json, or agent.")
    .action(async (path = ".", options) => {
      const format = await presentationFormat(options.format, metadataFormats);
      const root = resolve(cwd, path);
      if (!isDirectory(root)) {
        await writeCliError(`No readable directory found at ${root}`, format);
        exitCode = 2;
        return;
      }
      const { createMigrationReport, formatMigrationReport } = await import("./migration.js");
      const report = await createMigrationReport(root, options.to ? [options.to] : []);
      process.stdout.write(formatMigrationReport(report, format));
      exitCode = report.summary.errors > 0 ? 1 : 0;
    });
  cli
    .command("rules", "List available Doctor rules.")
    .option("--config <path>", "Explicitly load an executable Doctor config.")
    .option("--host-extensions", hostExtensionsHelp)
    .option("--format <format>", "Output: text, json, or agent.")
    .option("--framework <framework>", "Framework override.")
    .action(async (options) => {
      const format = await presentationFormat(options.format, metadataFormats);
      const runOptions: DoctorRunOptions = { root: cwd, format };
      applyDoctorOptions(runOptions, options);
      applyHostExtensions(runOptions, surface, options);
      validateCliRunOptions(runOptions);
      runOptions.config = await loadCliConfig(cwd, stringFlag(options.config));
      const { viteDoctorRulePacks } = await import("./doctor.js");
      process.stdout.write(createRulesReport(await viteDoctorRulePacks(runOptions), format));
    });
  cli
    .command("explain <diagnostic>", "Explain a Doctor Diagnostic Code or Rule.")
    .option("--config <path>", "Explicitly load an executable Doctor config.")
    .option("--host-extensions", hostExtensionsHelp)
    .option("--format <format>", "Output: text, json, or agent.")
    .option("--framework <framework>", "Framework override.")
    .action(async (diagnostic: string, options) => {
      const format = await presentationFormat(options.format, metadataFormats);
      const runOptions: DoctorRunOptions = { root: cwd, format };
      applyDoctorOptions(runOptions, options);
      applyHostExtensions(runOptions, surface, options);
      validateCliRunOptions(runOptions);
      runOptions.config = await loadCliConfig(cwd, stringFlag(options.config));
      const { viteDoctorRulePacks } = await import("./doctor.js");
      const report = explainRule(await viteDoctorRulePacks(runOptions), diagnostic, format);
      if (!report) {
        await writeCliError(`Unknown Diagnostic Code or Rule: ${diagnostic}`, format);
        exitCode = 2;
        return;
      }
      process.stdout.write(report);
    });
  cli
    .command("cache <action>", "Show (status) or remove (clean) the Doctor cache.")
    .option("--config <path>", "Explicitly load an executable Doctor config.")
    .option("--framework <framework>", "Framework override: vite, vue, nitro, or nuxt.")
    .option("--format <format>", "Output for cache status: text, json, or agent.")
    .action(async (action: string, options) => {
      if (action === "status") {
        const format = await presentationFormat(options.format, metadataFormats);
        const runOptions: DoctorRunOptions = { root: cwd };
        applyDoctorOptions(runOptions, options);
        validateCliRunOptions(runOptions);
        const { viteDoctorCacheStatus } = await import("./doctor.js");
        const status = await viteDoctorCacheStatus(
          cwd,
          await loadCliConfig(cwd, stringFlag(options.config)),
          runOptions.framework === "auto" ? undefined : runOptions.framework,
        );
        process.stdout.write(formatCacheStatus(status, format));
        return;
      }
      if (action === "clean") {
        const runOptions: DoctorRunOptions = { root: cwd };
        applyDoctorOptions(runOptions, options);
        validateCliRunOptions(runOptions);
        const { cleanViteDoctorCache } = await import("./doctor.js");
        await cleanViteDoctorCache(
          cwd,
          await loadCliConfig(cwd, stringFlag(options.config)),
          runOptions.framework === "auto" ? undefined : runOptions.framework,
        );
        consola.log("Doctor cache cleaned");
        return;
      }
      throw new Error(`Unknown cache action: ${action}. Use status or clean.`);
    });
  cli
    .command(
      "server <action> [path]",
      "Show (status) or stop (stop) the long-lived Doctor process.",
    )
    .option("--format <format>", "Output for server status: text, json, or agent.")
    .action(async (action: string, path = ".", options) => {
      const root = resolve(cwd, path);
      const client = await import("./doctor-process/client.js");
      if (action === "status") {
        const format = await presentationFormat(options.format, metadataFormats);
        const status = await client.doctorProcessStatus(root, doctorProcessEntry());
        process.stdout.write(formatServerStatus(status, format));
        return;
      }
      if (action === "stop") {
        const result = await client.stopDoctorProcess(root);
        consola.log(
          result.stopped
            ? `Doctor process ${result.pid} stopped`
            : `No Doctor process is running for ${root}`,
        );
        return;
      }
      throw new Error(`Unknown server action: ${action}. Use status or stop.`);
    });
  cli.help();

  try {
    cli.parse(["node", "vite-doctor", ...args], { run: false });
    validateSingleValueOptions(cli);
    const result = await cli.runMatchedCommand();
    if (typeof result === "number") exitCode = result;
    return exitCode;
  } catch (error) {
    const format = await requestedPresentation(args);
    await writeCliError(error instanceof Error ? error.message : String(error), format, {
      kind: error instanceof CliConfigError ? "config" : "invocation",
      file: error instanceof CliConfigError ? error.file : undefined,
      code: errorCode(error),
    });
    return 2;
  }
}

function formatCacheStatus(status: CacheStatus, format: MetadataReportFormat): string {
  if (format === "json") return `${JSON.stringify(status, null, 2)}\n`;
  if (format === "agent")
    return `${JSON.stringify({ schema: "vite-doctor.cache/v1", status: "ready", cache: status })}\n`;
  const state = !status.exists
    ? "missing"
    : status.version === undefined
      ? "unreadable, rebuilt on the next run"
      : status.compatible
        ? "current"
        : "written by another Doctor build, rebuilt on the next run";
  const lines = [`Doctor cache: ${status.path}`, `  state: ${state}`];
  if (status.version !== undefined) {
    lines.push(
      `  size: ${(status.bytes / 1024).toFixed(1)} KiB, written ${status.writtenAt}`,
      `  entries: ${status.files} files, ${status.ruleResults.file} file Rule results, ${status.ruleResults.run} run Rule results, ${status.inputs} Rule inputs${status.graph ? ", workspace graph summary" : ""}`,
    );
  }
  const last = status.lastWrite;
  if (last) {
    lines.push(
      `  last write: ${last.files} files, ${last.filesRead} read, ${last.filesParsed} parsed, ${last.ruleResultsReused} Rule results reused, ${last.ruleResultsComputed} computed, ${last.ruleResultsUncacheable} not cacheable${last.graphReused ? ", graph reused" : ""}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function formatServerStatus(status: DoctorProcessStatus, format: MetadataReportFormat): string {
  if (format === "json") return `${JSON.stringify(status, null, 2)}\n`;
  if (format === "agent")
    return `${JSON.stringify({ schema: "vite-doctor.server/v1", status: "ready", server: status })}\n`;
  const { state, activity } = status;
  if (!status.running || !state || !activity) {
    return `Doctor process for ${status.root}: not running\n  enable it with --server or ${DOCTOR_PROCESS_ENV}=1\n`;
  }
  const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${[
    `Doctor process for ${status.root}: running`,
    `  pid ${activity.pid}, Doctor ${state.version}, Node.js ${state.node}`,
    `  started ${state.startedAt}, stops after ${Math.round(state.idleTimeoutMs / 1000)} s idle`,
    `  runs: ${activity.runs}${activity.lastRunAt ? `, last ${activity.lastRunAt}` : ""}${activity.queued ? `, ${activity.queued} queued` : ""}`,
    `  memory: rss ${mib(activity.rssBytes)}, heap ${mib(activity.heapUsedBytes)}`,
    status.current
      ? "  current: yes, this CLI reuses it"
      : "  current: no, the next Doctor Run replaces it (Doctor, Node.js, config, or environment differ)",
    `  socket: ${state.socket}`,
    `  log: ${state.log}`,
  ].join("\n")}\n`;
}

function doctorProcessEntry(): URL | undefined {
  const entry = new URL("./doctor-process.mjs", import.meta.url);
  return existsSync(fileURLToPath(entry)) ? entry : undefined;
}

const hostExtensionsHelp =
  "Load Doctor Extension entries registered by host integrations, such as Nuxt modules.";

function applyHostExtensions(
  options: DoctorRunOptions,
  surface: CliSurfaceOptions,
  flags: Record<string, unknown>,
): void {
  if (surface.hostExtensions || flags.hostExtensions) options.hostExtensions = true;
}

function validateSingleValueOptions(cli: ReturnType<typeof cac>): void {
  for (const option of [...cli.globalCommand.options, ...(cli.matchedCommand?.options ?? [])]) {
    if (option.isBoolean || option.config.type) continue;
    if (!option.names.some((name) => Array.isArray(cli.options[name]))) continue;
    const flag = option.name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    throw new Error(`Option --${flag} may only be provided once.`);
  }
}

function addDoctorRunCommand(
  cli: ReturnType<typeof cac>,
  args: string[],
  cwd: string,
  surface: CliSurfaceOptions,
  setExitCode: (code: number) => void,
) {
  const command = cli
    .command("[path]", "Run Doctor diagnostics.")
    .option("--changed", "Report diagnostics on changed lines.")
    .option(
      "--analyses <analyses>",
      "Comma-separated analyses: dead-code, graph, dupes, or health.",
    )
    .option("--profile", "Include timings.")
    .option("--new-only", "Only report diagnostics absent from the baseline.")
    .option("--cache", "Use the persistent analysis cache (default: on).")
    .option("--no-cache", "Disable the persistent analysis cache for this run.")
    .option("--fix", "Apply safe edit plans and verify the result.")
    .option("--unsafe-fix", "Apply unsafe edit plans and verify the result.")
    .option("--max-warnings <count>", "Maximum warnings before failure.")
    .option("--framework <framework>", "Framework override: vite, vue, nitro, or nuxt.")
    .option("--rules <rules>", "Comma-separated Rule selectors.")
    .option("--severity <severity>", "Minimum severity: error, warn, or info.")
    .option("--extends <extends>", "Comma-separated rule-pack presets.")
    .option("--since <ref>", "Report diagnostics on lines changed since a Git ref.")
    .option("--baseline <file>", "Diagnostic baseline file.")
    .option("--update-baseline", "Write current Diagnostic fingerprints to the baseline file.")
    .option("--format <format>", "Output: text, json, sarif, or agent.")
    .option("--config <path>", "Explicitly load an executable Doctor config.")
    .option("--host-extensions", hostExtensionsHelp)
    .option("--watch", "Rerun Doctor when project files change.")
    .option(
      "--server",
      `Run through the long-lived Doctor process (or set ${DOCTOR_PROCESS_ENV}=1).`,
    )
    .option("--no-server", "Run in this process even when the Doctor process is enabled.")
    .action(async (path = ".", options) => {
      const format = await presentationFormat(options.format, reportFormats);
      const root = resolve(cwd, path);
      if (!isDirectory(root)) {
        await writeCliError(`No readable directory found at ${root}`, format);
        setExitCode(2);
        return;
      }
      const runOptions: DoctorRunOptions = { root, format };
      applyDoctorOptions(runOptions, options);
      applyHostExtensions(runOptions, surface, options);
      validateCliRunOptions(runOptions);
      const explicitConfig = stringFlag(options.config);
      const configFile = cliConfigFile(root, explicitConfig);
      runOptions.config = await loadCliConfig(root, explicitConfig);
      if (options.watch) {
        setExitCode(await watchDoctorCommand(args, cwd, surface, root, runOptions));
        return;
      }
      try {
        setExitCode(await runDoctorCommand(runOptions, format, explicitConfig));
      } catch (error) {
        if (configFile && isLoadedConfigValidationError(error, runOptions)) {
          throw createCliConfigError(configFile, error);
        }
        throw error;
      }
    });
  // cac defaults negated flags to true, which renders as `(default: true)` on `--no-cache`
  // and makes every run look like an explicit `--cache` in rerun commands.
  for (const option of command.options) if (option.negated) option.config.default = undefined;
}

async function watchDoctorCommand(
  args: string[],
  cwd: string,
  surface: CliSurfaceOptions,
  root: string,
  options: DoctorRunOptions,
): Promise<number> {
  if (options.fix || options.unsafeFix || options.updateBaseline) {
    throw new Error("--watch cannot be combined with --fix, --unsafe-fix, or --update-baseline.");
  }
  const [{ watchDoctorRuns }, { viteDoctorCacheStatus }] = await Promise.all([
    import("./doctor-process/watch.js"),
    import("./doctor.js"),
  ]);
  const cache = await viteDoctorCacheStatus(
    root,
    options.config,
    options.framework === "auto" ? undefined : options.framework,
  );
  const runArgs = args.filter((arg) => arg !== "--watch");
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    return await watchDoctorRuns({
      root,
      ignore: [dirname(cache.path)],
      run: () => main(runArgs, cwd, surface),
      signal: controller.signal,
      onRerun: (changed) =>
        process.stderr.write(`\n[vite-doctor] ${relative(root, changed)} changed, rerunning\n`),
    });
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

async function runDoctorCommand(
  options: DoctorRunOptions,
  format: DoctorReportFormat,
  configFile?: string,
): Promise<number> {
  const { runViteDoctor, shouldFailDoctorRun } = await import("./doctor.js");
  const result = await runViteDoctor(options);
  process.stdout.write(createReport(result, format, { runOptions: options, configFile }));
  if (reportStatus(result) === "incomplete") return 3;
  return shouldFailDoctorRun(result, options.maxWarnings) ? 1 : 0;
}

async function loadCliConfig(
  root: string,
  explicitConfig?: string,
): Promise<DoctorConfig | undefined> {
  if (explicitConfig) {
    const configFile = resolve(root, explicitConfig);
    try {
      return await loadDoctorConfig({ cwd: root, configFile });
    } catch (error) {
      throw createCliConfigError(configFile, error);
    }
  }
  const declarativeConfig = resolve(root, "doctor.config.json");
  if (!existsSync(declarativeConfig)) return undefined;
  try {
    const value = JSON.parse(readFileSync(declarativeConfig, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("doctor.config.json must contain a JSON object.");
    }
    return value as DoctorConfig;
  } catch (error) {
    throw createCliConfigError(declarativeConfig, error);
  }
}

async function presentationFormat<Format extends DoctorReportFormat>(
  value: unknown,
  supported: ReadonlySet<Format>,
): Promise<Format> {
  const explicit = stringFlag(value);
  if (explicit && !reportFormats.has(explicit as DoctorReportFormat)) {
    throw new Error(
      `Unknown report format ${JSON.stringify(explicit)}. Expected ${[...supported].join(", ")}.`,
    );
  }
  if (explicit && !supported.has(explicit as Format)) {
    throw new Error(
      `Report format ${JSON.stringify(explicit)} is not available here. Expected ${[...supported].join(", ")}.`,
    );
  }
  return (await selectDoctorPresentation(explicit as DoctorReportFormat | undefined))
    .format as Format;
}

async function requestedPresentation(args: string[]): Promise<DoctorReportFormat> {
  let explicit: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--format") explicit = args[index + 1];
    else if (args[index]?.startsWith("--format="))
      explicit = args[index]!.slice("--format=".length);
  }
  if (explicit && reportFormats.has(explicit as DoctorReportFormat)) {
    return (await selectDoctorPresentation(explicit as DoctorReportFormat)).format;
  }
  return (await selectDoctorPresentation()).format;
}

async function writeCliError(
  message: string,
  format: DoctorReportFormat,
  failure: { kind: "invocation" | "config"; file?: string; code?: string } = {
    kind: "invocation",
  },
): Promise<void> {
  if (format === "json" || format === "agent") {
    const indentation = format === "agent" ? undefined : 2;
    process.stdout.write(
      `${JSON.stringify(
        {
          schema: format === "agent" ? "vite-doctor.agent/v1" : "vite-doctor.report/v3",
          status: "failed",
          error: { kind: failure.kind, message, file: failure.file, code: failure.code },
          next:
            failure.kind === "config"
              ? { action: "fix-config", file: failure.file }
              : { action: "correct-invocation", command: "vite-doctor --help" },
        },
        null,
        indentation,
      )}\n`,
    );
    return;
  }
  if (format === "sarif") {
    process.stdout.write(
      `${JSON.stringify({
        version: "2.1.0",
        runs: [
          {
            tool: { driver: { name: "Vite Doctor", semanticVersion: viteDoctorVersion } },
            invocations: [
              {
                executionSuccessful: false,
                toolExecutionNotifications: [
                  {
                    level: "error",
                    message: { text: message },
                    properties: failure.code ? { diagnosticCode: failure.code } : undefined,
                  },
                ],
              },
            ],
            results: [],
          },
        ],
      })}\n`,
    );
    return;
  }
  consola.error(failure.code ? `[${failure.code}] ${message}` : message);
}

function isDirectory(path: string): boolean {
  return Boolean(statSync(path, { throwIfNoEntry: false })?.isDirectory());
}

function validateCliRunOptions(options: DoctorRunOptions): void {
  if (options.updateBaseline && !options.baseline)
    throw new Error("--update-baseline requires --baseline <file>.");
  if (options.framework && !frameworks.has(options.framework)) {
    throw new Error(
      `Unknown framework ${JSON.stringify(options.framework)}. Expected ${[...frameworks].join(", ")}.`,
    );
  }
  if (options.severity && !severities.has(options.severity)) {
    throw new Error(
      `Unknown severity ${JSON.stringify(options.severity)}. Expected ${[...severities].join(", ")}.`,
    );
  }
  if (
    options.maxWarnings !== undefined &&
    (!Number.isInteger(options.maxWarnings) || options.maxWarnings < 0)
  ) {
    throw new Error("--max-warnings must be a non-negative integer.");
  }
  const requestedAnalyses = options.analyses
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (options.analyses !== undefined && !requestedAnalyses?.length) {
    throw new Error("--analyses must select at least one analysis.");
  }
  const unknownAnalyses = requestedAnalyses?.filter((item) => !analyses.has(item));
  if (unknownAnalyses?.length) {
    throw new Error(
      `Unknown analysis ${JSON.stringify(unknownAnalyses[0])}. Expected ${[...analyses].join(", ")}.`,
    );
  }
}

function createCliConfigError(file: string, error: unknown): CliConfigError {
  const reason = error instanceof Error ? error.message : String(error);
  return new CliConfigError(
    file,
    `Could not load Doctor config at ${file}: ${reason}`,
    errorCode(error),
  );
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function cliConfigFile(root: string, explicitConfig?: string): string | undefined {
  if (explicitConfig) return resolve(root, explicitConfig);
  const declarativeConfig = resolve(root, "doctor.config.json");
  return existsSync(declarativeConfig) ? declarativeConfig : undefined;
}

function isLoadedConfigValidationError(error: unknown, options: DoctorRunOptions): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "DOC0019" || error.name === "DOC0020") return true;
  return (
    options.extends === undefined &&
    (error.name === "DOC0016" ||
      error.name === "DOC0017" ||
      error.name === "DOC0018" ||
      error.name === "DOC0024")
  );
}
