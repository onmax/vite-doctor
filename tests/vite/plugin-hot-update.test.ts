import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { createServer, type Logger, type ViteDevServer } from "vite";
import { expect, test, vi } from "vite-plus/test";
import type { DoctorRunOptions } from "../../src/core/index.ts";
import type { DoctorExtension } from "../../src/extension.ts";
import { doctor, type ViteDoctorSurfaceOptions } from "../../src/plugin.ts";

const doctorRuns = vi.hoisted(
  () => [] as Array<{ options: DoctorRunOptions; settled: Promise<unknown> }>,
);

vi.mock("../../src/doctor.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/doctor.ts")>();
  return {
    ...original,
    runViteDoctor(options: DoctorRunOptions) {
      const run = original.runViteDoctor(options);
      doctorRuns.push({ options, settled: run.catch(() => undefined) });
      return run;
    },
  };
});

const secretRule = "vite/env/no-client-secret-pattern";
const clean = 'export const greeting = "hello";\n';
const secret = "export const secret = import.meta.env.VITE_API_SECRET;\n";

async function withProject(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "doctor-plugin-hot-update-"));
  doctorRuns.length = 0;
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(root, "entry.ts"), clean);
    await writeFile(join(root, "other.ts"), clean);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function captureLogger() {
  const logs = { info: [] as string[], warn: [] as string[], error: [] as string[] };
  const logger: Logger = {
    info: (message) => void logs.info.push(message),
    warn: (message) => void logs.warn.push(message),
    warnOnce: (message) => void logs.warn.push(message),
    error: (message) => void logs.error.push(message),
    clearScreen() {},
    hasErrorLogged: () => false,
    hasWarned: false,
  };
  const all = () => [...logs.info, ...logs.warn, ...logs.error];
  return {
    logger,
    logs,
    reports: () => all().filter((message) => message.includes("Summary")),
    deltas: () => all().filter((message) => message.startsWith("Vite Doctor:")),
  };
}

/** Holds each Doctor Run inside Project Inventory until its gate is released. */
function gatedInventory() {
  const gates: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
  const extension: DoctorExtension = {
    name: "fixture/hot-update-gate",
    setup(api) {
      api.registerProjectInventoryContributor({
        name: "fixture-hot-update-gate",
        async contribute() {
          const gate = Promise.withResolvers<void>();
          gates.push(gate);
          await gate.promise;
          return {};
        },
      });
    },
  };
  return {
    extension,
    entered: () => gates.length,
    release: (index: number) => gates[index]!.resolve(),
  };
}

async function startServer(root: string, logger: Logger, options: ViteDoctorSurfaceOptions = {}) {
  const server = await createServer({
    root,
    configFile: false,
    customLogger: logger,
    plugins: [doctor({ run: "serve", rules: secretRule, cache: false, ...options })],
    server: { port: 0, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true },
  });
  await server.listen();
  return server;
}

async function save(server: ViteDevServer, file: string, text?: string) {
  if (text !== undefined) await writeFile(file, text);
  server.watcher.emit("change", file);
}

async function settled() {
  await Promise.all(doctorRuns.map((run) => run.settled));
  await new Promise((resolve) => setTimeout(resolve, 250));
  await Promise.all(doctorRuns.map((run) => run.settled));
}

test("a save logs only the Diagnostics it introduced or resolved", async () => {
  await withProject(async (root) => {
    const { logger, logs, reports, deltas } = captureLogger();
    const server = await startServer(root, logger);
    try {
      await vi.waitFor(() => expect(reports()).toHaveLength(1), { timeout: 15_000 });

      await save(server, join(root, "entry.ts"), secret);
      await vi.waitFor(() => expect(deltas()).toHaveLength(1), { timeout: 15_000 });
      expect(logs.error).toHaveLength(1);
      expect(logs.error[0]).toContain("1 new Diagnostic after changes to entry.ts");
      expect(logs.error[0]).toContain(secretRule);
      expect(logs.error[0]).toContain("Now: 0 blockers, 1 error, 0 warnings, 0 info");
      expect(doctorRuns[1]!.options.affectedFiles).toEqual([join(root, "entry.ts")]);

      await save(server, join(root, "entry.ts"), clean);
      await vi.waitFor(() => expect(deltas()).toHaveLength(2), { timeout: 15_000 });
      expect(logs.info.at(-1)).toContain("1 resolved after changes to entry.ts");
      expect(logs.info.at(-1)).toContain("Now: 0 blockers, 0 errors, 0 warnings, 0 info");

      await save(server, join(root, "other.ts"), 'export const greeting = "hi";\n');
      await settled();
      expect(doctorRuns).toHaveLength(4);
      expect(deltas()).toHaveLength(2);
      expect(reports()).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});

test("warn mode logs a new failing Diagnostic as a warning", async () => {
  await withProject(async (root) => {
    const { logger, logs, reports, deltas } = captureLogger();
    const server = await startServer(root, logger, { mode: "warn" });
    try {
      await vi.waitFor(() => expect(reports()).toHaveLength(1), { timeout: 15_000 });
      await save(server, join(root, "entry.ts"), secret);
      await vi.waitFor(() => expect(deltas()).toHaveLength(1), { timeout: 15_000 });
      expect(logs.warn.at(-1)).toContain(secretRule);
      expect(logs.error).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

test("rapid saves within the debounce window rerun Doctor once", async () => {
  await withProject(async (root) => {
    const { logger, reports, deltas } = captureLogger();
    const server = await startServer(root, logger);
    try {
      await vi.waitFor(() => expect(reports()).toHaveLength(1), { timeout: 15_000 });
      await writeFile(join(root, "entry.ts"), secret);
      for (let index = 0; index < 5; index++) await save(server, join(root, "entry.ts"));
      await save(server, join(root, "other.ts"), secret);

      await vi.waitFor(() => expect(deltas()).toHaveLength(1), { timeout: 15_000 });
      await settled();
      expect(doctorRuns).toHaveLength(2);
      expect(doctorRuns[1]!.options.affectedFiles?.toSorted()).toEqual([
        join(root, "entry.ts"),
        join(root, "other.ts"),
      ]);
      expect(deltas()[0]).toContain("2 new Diagnostics after changes to entry.ts, other.ts");
    } finally {
      await server.close();
    }
  });
});

test("a save during a rerun supersedes it and keeps its files", async () => {
  await withProject(async (root) => {
    const { logger, reports, deltas } = captureLogger();
    const gate = gatedInventory();
    const server = await startServer(root, logger, { extensions: [gate.extension] });
    try {
      await vi.waitFor(() => expect(gate.entered()).toBe(1), { timeout: 15_000 });
      gate.release(0);
      await vi.waitFor(() => expect(reports()).toHaveLength(1), { timeout: 15_000 });

      await save(server, join(root, "entry.ts"), secret);
      await vi.waitFor(() => expect(gate.entered()).toBe(2), { timeout: 15_000 });
      await save(server, join(root, "other.ts"), secret);
      await new Promise((resolve) => setTimeout(resolve, 250));
      // The superseded run still holds the main thread, so the next run waits for it.
      expect(gate.entered()).toBe(2);

      gate.release(1);
      await vi.waitFor(() => expect(gate.entered()).toBe(3), { timeout: 15_000 });
      gate.release(2);
      await vi.waitFor(() => expect(deltas()).toHaveLength(1), { timeout: 15_000 });
      await settled();
      expect(deltas()[0]).toContain("2 new Diagnostics after changes to other.ts, entry.ts");
      expect(doctorRuns[2]!.options.affectedFiles?.toSorted()).toEqual([
        join(root, "entry.ts"),
        join(root, "other.ts"),
      ]);
      expect(doctorRuns).toHaveLength(3);
    } finally {
      await server.close();
    }
  });
});

test("a package manifest reruns the whole project and other files rerun nothing", async () => {
  await withProject(async (root) => {
    const { logger, reports } = captureLogger();
    const server = await startServer(root, logger);
    try {
      await vi.waitFor(() => expect(reports()).toHaveLength(1), { timeout: 15_000 });
      await mkdir(join(root, ".vite-doctor/cache"), { recursive: true });
      await mkdir(join(root, "node_modules/dep"), { recursive: true });
      await save(server, join(root, "style.css"), "body {}\n");
      await save(server, join(root, ".vite-doctor/cache/entry.ts"), clean);
      await save(server, join(root, "node_modules/dep/index.js"), clean);
      await save(server, join(tmpdir(), "outside.ts"));
      await settled();
      expect(doctorRuns).toHaveLength(1);

      await save(server, join(root, "package.json"));
      await save(server, join(root, "entry.ts"), secret);
      await vi.waitFor(() => expect(doctorRuns).toHaveLength(2), { timeout: 15_000 });
      await settled();
      expect(doctorRuns).toHaveLength(2);
      expect(doctorRuns[1]!.options.affectedFiles).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});

test("closing the dev server stops listening for saves", async () => {
  await withProject(async (root) => {
    const { logger, reports } = captureLogger();
    const server = await startServer(root, logger);
    await vi.waitFor(() => expect(reports()).toHaveLength(1), { timeout: 15_000 });
    const watcher = server.watcher;
    await server.close();
    watcher.emit("change", join(root, "entry.ts"));
    await settled();
    expect(doctorRuns).toHaveLength(1);
  });
});
