import { flushStoreWrites, retainCacheStores } from "../core/internal/cache-store.js";
import type { OutputChunk } from "./protocol.js";

export interface CapturedRun {
  exitCode: number;
  output: OutputChunk[];
}

/**
 * The long-lived Doctor engine behind the Doctor process and `--watch`: Doctor Runs execute one at
 * a time in this process, keep loaded Rule Packs and parsed cache stores between runs, and write
 * each store after the run has reported.
 */
export class DoctorEngine {
  runs = 0;
  queued = 0;
  lastRunAt: Date | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private gcTimer: NodeJS.Timeout | undefined;

  constructor() {
    retainCacheStores();
  }

  /** Runs `task` after every earlier task, then writes the stores its Doctor Run deferred. */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    clearTimeout(this.gcTimer);
    this.queued++;
    const result = this.tail.then(async () => {
      try {
        return await task();
      } finally {
        this.queued--;
        this.runs++;
        this.lastRunAt = new Date();
        flushStoreWrites();
        if (this.queued === 0) this.collectWhenIdle();
      }
    });
    this.tail = result.catch(() => {});
    return result;
  }

  idle(): Promise<void> {
    return this.tail.then(() => {});
  }

  /**
   * A Doctor Run leaves most of its heap as garbage that V8 keeps mapped while the process idles,
   * so the Doctor process starts with `--expose-gc` and collects after a pause. A full collection
   * takes hundreds of milliseconds, too long to pay between runs an agent issues back to back.
   */
  private collectWhenIdle(): void {
    const gc = (globalThis as { gc?: () => void }).gc;
    if (!gc) return;
    clearTimeout(this.gcTimer);
    this.gcTimer = setTimeout(gc, GC_IDLE_MS);
    this.gcTimer.unref();
  }
}

const GC_IDLE_MS = 10_000;

/**
 * Runs `run` with the client's environment and captures what it writes, in write order, so the
 * client can replay stdout and stderr byte for byte. Callers serialize runs through the engine.
 */
export async function captureRun(
  env: Record<string, string>,
  run: () => Promise<number>,
): Promise<CapturedRun> {
  const output: OutputChunk[] = [];
  const restoreEnv = applyEnvironment(env);
  const restoreStdout = replaceWrite(process.stdout, capture(output, 1));
  const restoreStderr = replaceWrite(process.stderr, capture(output, 2));
  try {
    return { exitCode: await run(), output };
  } finally {
    restoreStdout();
    restoreStderr();
    restoreEnv();
  }
}

function replaceWrite(stream: NodeJS.WriteStream, write: NodeJS.WriteStream["write"]) {
  const own = Object.getOwnPropertyDescriptor(stream, "write");
  stream.write = write;
  return () => {
    if (own) Object.defineProperty(stream, "write", own);
    else delete (stream as { write?: unknown }).write;
  };
}

function capture(output: OutputChunk[], fd: 1 | 2): typeof process.stdout.write {
  return ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    const done = typeof encoding === "function" ? encoding : callback;
    const bytes =
      typeof chunk === "string"
        ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8")
        : Buffer.from(chunk);
    output.push([fd, bytes.toString("base64")]);
    if (done) process.nextTick(done);
    return true;
  }) as typeof process.stdout.write;
}

function applyEnvironment(env: Record<string, string>): () => void {
  const previous = { ...process.env };
  replaceEnvironment(env);
  return () => replaceEnvironment(previous);
}

function replaceEnvironment(env: Record<string, string | undefined>): void {
  for (const name of Object.keys(process.env)) if (!(name in env)) delete process.env[name];
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) process.env[name] = value;
  }
}
