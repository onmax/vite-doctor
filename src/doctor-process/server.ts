import { randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { viteDoctorVersion } from "../version.js";
import { captureRun, DoctorEngine } from "./engine.js";
import {
  connectSocket,
  doctorProcessRoot,
  ensurePrivateDirectory,
  protocolVersion,
  receiveMessage,
  removeDoctorProcessState,
  sendMessage,
  writeDoctorProcessState,
  type DoctorProcessPaths,
  type DoctorProcessRequest,
  type DoctorProcessResponse,
  type DoctorProcessState,
} from "./protocol.js";

export interface DoctorProcessServerOptions {
  root: string;
  key: string;
  paths: DoctorProcessPaths;
  idleTimeoutMs: number;
}

export interface DoctorProcessServer {
  state: DoctorProcessState;
  /** Resolves once the process stopped serving and removed its socket and state. */
  closed: Promise<void>;
  stop(): Promise<void>;
}

/** Reads the options a client passes to a Doctor process it starts. */
export function parseServerOptions(text = ""): DoctorProcessServerOptions {
  const value: unknown = JSON.parse(text);
  const options = value as Partial<DoctorProcessServerOptions> | null;
  const paths = options?.paths;
  if (
    typeof options?.root !== "string" ||
    typeof options.key !== "string" ||
    typeof options.idleTimeoutMs !== "number" ||
    !(options.idleTimeoutMs > 0) ||
    !paths ||
    !["directory", "socket", "state", "log"].every(
      (name) => typeof paths[name as keyof DoctorProcessPaths] === "string",
    )
  ) {
    throw new Error("Invalid Doctor process options.");
  }
  return { root: options.root, key: options.key, paths, idleTimeoutMs: options.idleTimeoutMs };
}

/**
 * Serves Doctor Runs for one project root over a local socket. Returns undefined when another
 * Doctor process already serves this root.
 */
export async function serveDoctorProcess(
  options: DoctorProcessServerOptions,
): Promise<DoctorProcessServer | undefined> {
  const { paths } = options;
  if (!ensurePrivateDirectory(paths.directory)) {
    throw new Error(`Doctor process directory ${paths.directory} is not private to this user.`);
  }
  const engine = new DoctorEngine();
  const token = randomBytes(24).toString("hex");
  const sockets = new Set<Socket>();
  let stopping: Promise<void> | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    void handle(socket);
  });
  if (!(await listen(server, paths.socket))) return undefined;
  const socketIdentity = socketFileIdentity(paths.socket);

  const state: DoctorProcessState = {
    protocol: protocolVersion(),
    pid: process.pid,
    root: options.root,
    key: options.key,
    version: viteDoctorVersion,
    node: process.version,
    socket: paths.socket,
    log: paths.log,
    token,
    startedAt: new Date().toISOString(),
    idleTimeoutMs: options.idleTimeoutMs,
  };
  writeDoctorProcessState(paths, state);
  armIdleTimer();

  async function handle(socket: Socket): Promise<void> {
    let request: DoctorProcessRequest;
    try {
      request = (await receiveMessage(socket)) as DoctorProcessRequest;
    } catch {
      socket.destroy();
      return;
    }
    if (!request || typeof request !== "object" || !sameToken(request.token, token)) {
      socket.destroy();
      return;
    }
    const reply = (response: DoctorProcessResponse) =>
      sendMessage(socket, response).finally(() => socket.end());
    if (request.kind === "status") {
      const memory = process.memoryUsage();
      await reply({
        kind: "status",
        activity: {
          pid: process.pid,
          runs: engine.runs,
          queued: engine.queued,
          lastRunAt: engine.lastRunAt?.toISOString(),
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
        },
      }).catch(() => {});
      return;
    }
    if (request.kind === "stop") {
      await reply({ kind: "stopping" }).catch(() => {});
      void stop();
      return;
    }
    // Enforced here as well as in the client: the Doctor process never runs an invocation that
    // loads executable config or host Doctor Extensions, whoever connects.
    if (
      request.kind !== "run" ||
      !isRunRequest(request) ||
      doctorProcessRoot(request.args, request.cwd) !== request.root
    ) {
      await reply({
        kind: "error",
        message: "The Doctor process does not serve this request.",
      }).catch(() => {});
      return;
    }
    if (stopping || request.key !== options.key || request.root !== options.root) {
      await reply({ kind: "mismatch" }).catch(() => {});
      if (request.key !== options.key) void stop();
      return;
    }
    clearTimeout(idleTimer);
    await engine
      .enqueue(async () => {
        const { main } = await import("../cli-main.js");
        const result = await captureRun(request.env, () => main(request.args, request.cwd));
        await reply({ kind: "output", ...result }).catch(() => {});
      })
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        await reply({ kind: "error", message }).catch(() => {});
      });
    armIdleTimer();
  }

  function armIdleTimer(): void {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (engine.queued === 0) void stop();
      else armIdleTimer();
    }, options.idleTimeoutMs);
    idleTimer.unref();
  }

  function stop(): Promise<void> {
    stopping ??= (async () => {
      clearTimeout(idleTimer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await engine.idle();
      for (const socket of sockets) socket.destroy();
      removeDoctorProcessState(paths, token);
      // A replacement may already listen on the same path once this server stopped accepting.
      if (socketIdentity && socketFileIdentity(paths.socket) === socketIdentity)
        rmSync(paths.socket, { force: true });
      resolveClosed();
    })();
    return stopping;
  }

  return { state, closed, stop };
}

/** Listens on `path`, replacing a socket file that no live Doctor process answers on. */
async function listen(server: Server, path: string): Promise<boolean> {
  try {
    await listenOnce(server, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
  }
  try {
    (await connectSocket(path)).destroy();
    return false;
  } catch {}
  if (process.platform !== "win32") rmSync(path, { force: true });
  try {
    await listenOnce(server, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return false;
    throw error;
  }
}

function socketFileIdentity(path: string): string | undefined {
  if (process.platform === "win32") return undefined;
  const stats = lstatSync(path, { throwIfNoEntry: false });
  return stats && `${stats.dev}:${stats.ino}`;
}

function listenOnce(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function sameToken(value: unknown, token: string): boolean {
  if (typeof value !== "string" || value.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(token));
}

function isRunRequest(request: Extract<DoctorProcessRequest, { kind: "run" }>): boolean {
  return (
    typeof request.key === "string" &&
    typeof request.root === "string" &&
    typeof request.cwd === "string" &&
    Array.isArray(request.args) &&
    request.args.every((arg) => typeof arg === "string") &&
    Boolean(request.env) &&
    typeof request.env === "object" &&
    Object.values(request.env).every((value) => typeof value === "string")
  );
}
