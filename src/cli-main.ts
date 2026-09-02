import { existsSync, readFileSync, statSync } from "node:fs";
import { cac } from "cac";
import { consola } from "consola";
import { resolve } from "pathe";
import {
  cleanCache,
  createReport,
  createRulesReport,
  explainRule,
  loadDoctorConfig,
  reportStatus,
  type DoctorConfig,
  type DoctorReportFormat,
  type DoctorRunOptions,
} from "./core/index.js";
import { selectDoctorPresentation } from "./core/internal/agent-runtime.js";
import { applyDoctorOptions, stringFlag } from "./core/internal/cli.js";
import { runViteDoctor, shouldFailDoctorRun, viteDoctorRulePacks } from "./doctor.js";
import { viteDoctorVersion } from "./version.js";
import { createMigrationReport, formatMigrationReport } from "./migration.js";

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
  ) {
    super(message);
  }
}

export async function main(args = process.argv.slice(2), cwd = process.cwd()): Promise<number> {
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
  addDoctorRunCommand(cli, cwd, (code) => (exitCode = code));
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
      const report = await createMigrationReport(root, options.to ? [options.to] : []);
      process.stdout.write(formatMigrationReport(report, format));
      exitCode = report.summary.errors > 0 ? 1 : 0;
    });
  cli
    .command("rules", "List available Doctor rules.")
    .option("--format <format>", "Output: text, json, or agent.")
    .option("--framework <framework>", "Framework override.")
    .action(async (options) => {
      const format = await presentationFormat(options.format, metadataFormats);
      const runOptions: DoctorRunOptions = { root: cwd, format };
      applyDoctorOptions(runOptions, options);
      validateCliRunOptions(runOptions);
      process.stdout.write(createRulesReport(await viteDoctorRulePacks(runOptions), format));
    });
  cli
    .command("explain <diagnostic>", "Explain a Doctor Diagnostic Code or Rule.")
    .option("--format <format>", "Output: text, json, or agent.")
    .option("--framework <framework>", "Framework override.")
    .action(async (diagnostic: string, options) => {
      const format = await presentationFormat(options.format, metadataFormats);
      const runOptions: DoctorRunOptions = { root: cwd, format };
      applyDoctorOptions(runOptions, options);
      validateCliRunOptions(runOptions);
      const report = explainRule(await viteDoctorRulePacks(runOptions), diagnostic, format);
      if (!report) {
        await writeCliError(`Unknown Diagnostic Code or Rule: ${diagnostic}`, format);
        exitCode = 2;
        return;
      }
      process.stdout.write(report);
    });
  cli.command("cache <action>", "Manage Doctor cache.").action((action: string) => {
    if (action === "clean") {
      cleanCache(cwd);
      consola.log("Doctor cache cleaned");
      return;
    }
    throw new Error(`Unknown cache action: ${action}`);
  });
  cli.help();

  try {
    cli.parse(["node", "vite-doctor", ...args], { run: false });
    const result = await cli.runMatchedCommand();
    if (typeof result === "number") exitCode = result;
    return exitCode;
  } catch (error) {
    const format = await requestedPresentation(args);
    await writeCliError(error instanceof Error ? error.message : String(error), format, {
      kind: error instanceof CliConfigError ? "config" : "invocation",
      file: error instanceof CliConfigError ? error.file : undefined,
    });
    return 2;
  }
}

function addDoctorRunCommand(
  cli: ReturnType<typeof cac>,
  cwd: string,
  setExitCode: (code: number) => void,
) {
  cli
    .command("[path]", "Run Doctor diagnostics.")
    .option("--changed", "Report diagnostics on changed lines.")
    .option("--types", "Enable type-aware rules.")
    .option(
      "--analyses <analyses>",
      "Comma-separated analyses: dead-code, graph, dupes, or health.",
    )
    .option("--profile", "Include timings.")
    .option("--new-only", "Only report diagnostics absent from the baseline.")
    .option("--cache", "Use the analysis cache.")
    .option("--no-cache", "Disable the analysis cache.")
    .option("--fix", "Apply safe edit plans and verify the result.")
    .option("--unsafe-fix", "Apply unsafe edit plans and verify the result.")
    .option("--max-warnings <count>", "Maximum warnings before failure.")
    .option("--framework <framework>", "Framework override: vite, vue, nitro, or nuxt.")
    .option("--rules <rules>", "Comma-separated Rule selectors.")
    .option("--severity <severity>", "Minimum severity: error, warn, or info.")
    .option("--extends <extends>", "Comma-separated rule-pack presets.")
    .option("--since <ref>", "Report diagnostics on lines changed since a Git ref.")
    .option("--baseline <file>", "Diagnostic baseline file.")
    .option("--format <format>", "Output: text, json, sarif, or agent.")
    .option("--config <path>", "Explicitly load an executable Doctor config.")
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
      validateCliRunOptions(runOptions);
      const explicitConfig = stringFlag(options.config);
      const configFile = cliConfigFile(root, explicitConfig);
      runOptions.config = await loadCliConfig(root, explicitConfig);
      try {
        setExitCode(await runDoctorCommand(runOptions, format));
      } catch (error) {
        if (configFile && isLoadedConfigValidationError(error, runOptions)) {
          throw createCliConfigError(configFile, error);
        }
        throw error;
      }
    });
}

async function runDoctorCommand(
  options: DoctorRunOptions,
  format: DoctorReportFormat,
): Promise<number> {
  const result = await runViteDoctor(options);
  process.stdout.write(createReport(result, format));
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
  failure: { kind: "invocation" | "config"; file?: string } = { kind: "invocation" },
): Promise<void> {
  if (format === "json" || format === "agent") {
    const indentation = format === "agent" ? undefined : 2;
    process.stdout.write(
      `${JSON.stringify(
        {
          schema: format === "agent" ? "vite-doctor.agent/v1" : "vite-doctor.report/v3",
          status: "failed",
          error: { kind: failure.kind, message, file: failure.file },
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
                toolExecutionNotifications: [{ level: "error", message: { text: message } }],
              },
            ],
            results: [],
          },
        ],
      })}\n`,
    );
    return;
  }
  consola.error(message);
}

function isDirectory(path: string): boolean {
  return Boolean(statSync(path, { throwIfNoEntry: false })?.isDirectory());
}

function validateCliRunOptions(options: DoctorRunOptions): void {
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
  return new CliConfigError(file, `Could not load Doctor config at ${file}: ${reason}`);
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
    (error.name === "DOC0016" || error.name === "DOC0017" || error.name === "DOC0018")
  );
}
