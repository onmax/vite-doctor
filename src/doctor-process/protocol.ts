import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const DOCTOR_PROCESS_ENV = "VITE_DOCTOR_SERVER";
export const DOCTOR_PROCESS_IDLE_ENV = "VITE_DOCTOR_SERVER_IDLE_MS";
export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000;
const PROTOCOL = 1;
const MAX_MESSAGE_BYTES = 256 * 1024 * 1024;

export interface DoctorProcessPaths {
  directory: string;
  socket: string;
  state: string;
  log: string;
}

/** What a running Doctor process publishes about itself, readable only by its user. */
export interface DoctorProcessState {
  protocol: number;
  pid: number;
  root: string;
  key: string;
  version: string;
  node: string;
  socket: string;
  log: string;
  token: string;
  startedAt: string;
  idleTimeoutMs: number;
}

export type OutputChunk = [fd: 1 | 2, base64: string];

export type DoctorProcessRequest =
  | {
      kind: "run";
      token: string;
      key: string;
      root: string;
      cwd: string;
      args: string[];
      env: Record<string, string>;
    }
  | { kind: "status"; token: string }
  | { kind: "stop"; token: string };

export interface DoctorProcessActivity {
  pid: number;
  runs: number;
  queued: number;
  lastRunAt?: string;
  rssBytes: number;
  heapUsedBytes: number;
}

export type DoctorProcessResponse =
  | { kind: "output"; exitCode: number; output: OutputChunk[] }
  | { kind: "mismatch" }
  | { kind: "status"; activity: DoctorProcessActivity }
  | { kind: "stopping" }
  | { kind: "error"; message: string };

const RUN_COMMANDS = new Set([
  "migrate",
  "rules",
  "explain",
  "cache",
  "server",
  "run",
  "ci",
  "scan",
  "check",
]);
const VALUE_OPTIONS = new Set([
  "analyses",
  "max-warnings",
  "framework",
  "rules",
  "severity",
  "extends",
  "since",
  "baseline",
  "format",
]);
const BOOLEAN_OPTIONS = new Set([
  "changed",
  "profile",
  "new-only",
  "cache",
  "no-cache",
  "fix",
  "unsafe-fix",
  "update-baseline",
  "server",
  "no-server",
]);

/**
 * The project root of a Doctor Run invocation the Doctor process may serve. Anything else runs
 * directly: other commands, `--watch`, help, unknown options, and every invocation that loads
 * executable code, which is an explicit `--config` or host Doctor Extensions.
 */
export function doctorProcessRoot(args: readonly string[], cwd: string): string | undefined {
  let path: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = arg.slice(2, equals === -1 ? undefined : equals);
      if (VALUE_OPTIONS.has(name)) {
        if (equals !== -1) continue;
        const value = args[index + 1];
        if (value === undefined || value.startsWith("-")) return undefined;
        index++;
        continue;
      }
      if (BOOLEAN_OPTIONS.has(name) && equals === -1) continue;
      return undefined;
    }
    if (arg.startsWith("-") || path !== undefined) return undefined;
    path = arg;
  }
  if (path !== undefined && RUN_COMMANDS.has(path)) return undefined;
  const root = resolve(cwd, path ?? ".");
  return statSync(root, { throwIfNoEntry: false })?.isDirectory() ? root : undefined;
}

/**
 * Sockets live in a per-user runtime directory instead of the project cache directory: Unix socket
 * paths are limited to about 100 bytes, the cache directory depends on framework detection, and
 * project file watchers must not see socket churn.
 */
export function doctorProcessPaths(root: string): DoctorProcessPaths {
  const uid = process.getuid?.();
  const directory = join(tmpdir(), uid === undefined ? "vite-doctor" : `vite-doctor-${uid}`);
  const id = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return {
    directory,
    socket:
      process.platform === "win32"
        ? `\\\\.\\pipe\\vite-doctor-${createHash("sha256").update(directory).digest("hex").slice(0, 8)}-${id}`
        : join(directory, `${id}.sock`),
    state: join(directory, `${id}.json`),
    log: join(directory, `${id}.log`),
  };
}

/** The directory must belong to this user and stay closed to others, or Doctor runs directly. */
export function ensurePrivateDirectory(directory: string): boolean {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stats = lstatSync(directory);
    if (!stats.isDirectory()) return false;
    if (process.platform === "win32") return true;
    return stats.uid === process.getuid?.() && (stats.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

export function readDoctorProcessState(paths: DoctorProcessPaths): DoctorProcessState | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(paths.state, "utf8"));
    return isDoctorProcessState(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writeDoctorProcessState(paths: DoctorProcessPaths, state: DoctorProcessState) {
  const temporary = `${paths.state}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  renameSync(temporary, paths.state);
}

/** Removes the published state only while it still describes the process holding `token`. */
export function removeDoctorProcessState(paths: DoctorProcessPaths, token: string): void {
  if (readDoctorProcessState(paths)?.token !== token) return;
  rmSync(paths.state, { force: true });
}

export function stateMatches(state: DoctorProcessState, key: string): boolean {
  return state.protocol === PROTOCOL && state.key === key;
}

export function protocolVersion(): number {
  return PROTOCOL;
}

export function fileIdentity(path: string): string {
  try {
    const stats = statSync(path);
    return `${stats.size}:${stats.mtimeMs}`;
  } catch {
    return "missing";
  }
}

export function sendMessage(socket: Socket, message: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve()));
  });
}

/** Resolves with the first newline-terminated JSON message, or rejects when the peer leaves. */
export function receiveMessage(socket: Socket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const finish = (error?: Error, value?: unknown) => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("close", onEnd);
      socket.off("error", onError);
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      const newline = chunk.indexOf(10);
      if (newline === -1) {
        chunks.push(chunk);
        bytes += chunk.length;
        if (bytes > MAX_MESSAGE_BYTES) finish(new Error("Doctor process message is too large."));
        return;
      }
      chunks.push(chunk.subarray(0, newline));
      try {
        finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        finish(error as Error);
      }
    };
    const onEnd = () => finish(new Error("Doctor process connection closed."));
    const onError = (error: Error) => finish(error);
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("close", onEnd);
    socket.once("error", onError);
  });
}

export function connectSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

export async function requestDoctorProcess(
  state: Pick<DoctorProcessState, "socket">,
  request: DoctorProcessRequest,
): Promise<DoctorProcessResponse> {
  const socket = await connectSocket(state.socket);
  try {
    const response = receiveMessage(socket);
    await sendMessage(socket, request);
    return (await response) as DoctorProcessResponse;
  } finally {
    socket.destroy();
  }
}

function isDoctorProcessState(value: unknown): value is DoctorProcessState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.protocol === "number" &&
    typeof state.pid === "number" &&
    typeof state.root === "string" &&
    typeof state.key === "string" &&
    typeof state.version === "string" &&
    typeof state.node === "string" &&
    typeof state.socket === "string" &&
    typeof state.log === "string" &&
    typeof state.token === "string" &&
    typeof state.startedAt === "string" &&
    typeof state.idleTimeoutMs === "number"
  );
}
