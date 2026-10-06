import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { viteDoctorVersion } from "../version.js";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DOCTOR_PROCESS_ENV,
  DOCTOR_PROCESS_IDLE_ENV,
  doctorProcessPaths,
  doctorProcessRoot,
  ensurePrivateDirectory,
  fileIdentity,
  protocolVersion,
  readDoctorProcessState,
  removeDoctorProcessState,
  requestDoctorProcess,
  stateMatches,
  type DoctorProcessActivity,
  type DoctorProcessPaths,
  type DoctorProcessState,
  type OutputChunk,
} from "./protocol.js";

export { doctorProcessRoot };

export interface DoctorProcessLaunch {
  root: string;
  key: string;
  paths: DoctorProcessPaths;
  idleTimeoutMs: number;
}

export interface DoctorProcessClientOptions {
  /** The Doctor process entry. Without one, as in source checkouts, Doctor runs directly. */
  entry?: URL;
  /** Starts a Doctor process; resolves `exited` if it stops before serving. */
  start?: (launch: DoctorProcessLaunch) => { exited?: Promise<unknown> } | void;
  identity?: string;
  interactive?: boolean;
  readyTimeoutMs?: number;
}

export function doctorProcessRequested(args: readonly string[], env = process.env): boolean {
  if (args.includes("--no-server")) return false;
  if (args.includes("--server")) return true;
  const value = env[DOCTOR_PROCESS_ENV];
  return value === "1" || value === "true";
}

/**
 * Runs a CLI invocation through the project's long-lived Doctor process, starting one when none
 * serves this Doctor build, Node.js, config, and presentation environment. Returns undefined when
 * the invocation must or should run directly; output is then produced by the direct run.
 */
export async function runThroughDoctorProcess(
  args: string[],
  cwd: string,
  options: DoctorProcessClientOptions = {},
): Promise<number | undefined> {
  if (!options.entry && !options.start) return undefined;
  if (options.interactive ?? (process.stdout.isTTY || process.stderr.isTTY)) return undefined;
  const root = doctorProcessRoot(args, cwd);
  if (!root) return undefined;
  const paths = doctorProcessPaths(root);
  if (!ensurePrivateDirectory(paths.directory)) return undefined;
  const key = options.identity ?? (await doctorProcessIdentity(root, options.entry));
  const launch: DoctorProcessLaunch = { root, key, paths, idleTimeoutMs: idleTimeout() };
  const start = options.start ?? ((value) => spawnDoctorProcess(options.entry!, value));

  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await connectOrStart(launch, start, options.readyTimeoutMs ?? 20_000);
    if (!state) return undefined;
    let response;
    try {
      response = await requestDoctorProcess(state, {
        kind: "run",
        token: state.token,
        key,
        root,
        cwd,
        args,
        env: stringEnvironment(process.env),
      });
    } catch {
      removeDoctorProcessState(paths, state.token);
      continue;
    }
    if (response.kind === "output") {
      writeOutput(response.output);
      return response.exitCode;
    }
    if (response.kind !== "mismatch") return undefined;
    await retire(state, paths);
  }
  return undefined;
}

/**
 * Identifies what a Doctor process must share with a client for its output to match a direct run:
 * the Doctor build, Node.js, the declarative config, and the presentation state that dependencies
 * derive from the environment once at import time (CI, colors, log level).
 */
export async function doctorProcessIdentity(root: string, entry?: URL): Promise<string> {
  const [environment, colors] = await Promise.all([import("std-env"), import("picocolors")]);
  const presentation = [
    environment.isCI,
    environment.isTest,
    environment.isDebug,
    environment.isMinimal,
    environment.isColorSupported,
    environment.provider,
    colors.default.isColorSupported,
    process.env.CONSOLA_LEVEL ?? null,
    process.env.NODE_ENV ?? null,
  ];
  let config = "none";
  try {
    config = sha256(readFileSync(join(root, "doctor.config.json"), "utf8"));
  } catch {}
  return sha256(
    JSON.stringify([
      protocolVersion(),
      viteDoctorVersion,
      entry ? fileIdentity(fileURLToPath(entry)) : "in-process",
      fileIdentity(fileURLToPath(import.meta.url)),
      process.version,
      process.execPath,
      process.arch,
      root,
      config,
      presentation,
    ]),
  );
}

export interface DoctorProcessStatus {
  root: string;
  running: boolean;
  /** Whether this CLI would reuse the running process instead of replacing it. */
  current?: boolean;
  state?: Omit<DoctorProcessState, "token">;
  activity?: DoctorProcessActivity;
  directory: string;
}

export async function doctorProcessStatus(root: string, entry?: URL): Promise<DoctorProcessStatus> {
  const paths = doctorProcessPaths(root);
  const state = readDoctorProcessState(paths);
  const status: DoctorProcessStatus = { root, running: false, directory: paths.directory };
  if (!state) return status;
  try {
    const response = await requestDoctorProcess(state, { kind: "status", token: state.token });
    if (response.kind !== "status") return status;
    const { token: _token, ...published } = state;
    return {
      ...status,
      running: true,
      current: stateMatches(state, await doctorProcessIdentity(root, entry)),
      state: published,
      activity: response.activity,
    };
  } catch {
    removeDoctorProcessState(paths, state.token);
    return status;
  }
}

export async function stopDoctorProcess(root: string): Promise<{ stopped: boolean; pid?: number }> {
  const paths = doctorProcessPaths(root);
  const state = readDoctorProcessState(paths);
  if (!state) return { stopped: false };
  return (await retire(state, paths)) ? { stopped: true, pid: state.pid } : { stopped: false };
}

async function connectOrStart(
  launch: DoctorProcessLaunch,
  start: NonNullable<DoctorProcessClientOptions["start"]>,
  readyTimeoutMs: number,
): Promise<DoctorProcessState | undefined> {
  const current = readDoctorProcessState(launch.paths);
  if (current && stateMatches(current, launch.key)) return current;
  if (current) await retire(current, launch.paths);
  let exited = false;
  try {
    void start(launch)?.exited?.then(() => (exited = true));
  } catch {
    return undefined;
  }
  const deadline = Date.now() + readyTimeoutMs;
  for (let delay = 5; Date.now() < deadline; delay = Math.min(delay * 2, 50)) {
    const state = readDoctorProcessState(launch.paths);
    if (state && stateMatches(state, launch.key)) return state;
    if (exited && !state) return undefined;
    await sleep(delay);
  }
  return undefined;
}

/** Asks a Doctor process to stop and waits until it no longer publishes itself. */
async function retire(state: DoctorProcessState, paths: DoctorProcessPaths): Promise<boolean> {
  try {
    await requestDoctorProcess(state, { kind: "stop", token: state.token });
  } catch {
    removeDoctorProcessState(paths, state.token);
    return false;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (readDoctorProcessState(paths)?.token !== state.token) return true;
    await sleep(10);
  }
  return true;
}

function spawnDoctorProcess(entry: URL, launch: DoctorProcessLaunch) {
  const log = openSync(launch.paths.log, "w", 0o600);
  try {
    const args = ["--expose-gc", fileURLToPath(entry), JSON.stringify(launch)];
    const child = spawn(process.execPath, args, {
      cwd: launch.root,
      detached: true,
      env: process.env,
      stdio: ["ignore", log, log],
      windowsHide: true,
    });
    const exited = new Promise((resolveExit) => {
      child.once("exit", resolveExit);
      child.once("error", resolveExit);
    });
    child.unref();
    return { exited };
  } finally {
    closeSync(log);
  }
}

function writeOutput(output: OutputChunk[]): void {
  for (const [fd, chunk] of output) {
    (fd === 1 ? process.stdout : process.stderr).write(Buffer.from(chunk, "base64"));
  }
}

function idleTimeout(): number {
  const value = Number(process.env[DOCTOR_PROCESS_IDLE_ENV]);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_IDLE_TIMEOUT_MS;
}

function stringEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) result[name] = value;
  return result;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
