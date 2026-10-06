import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, createServer, type InlineConfig, type Logger, type ViteDevServer } from "vite";
import { expect, test, vi } from "vite-plus/test";
import type { DoctorExtension } from "../../src/extension.ts";
import { doctor, type ViteDoctorSurfaceOptions } from "../../src/plugin.ts";

const doctorRuns = vi.hoisted(() => [] as Promise<unknown>[]);

vi.mock("../../src/doctor.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/doctor.ts")>();
  return {
    ...original,
    runViteDoctor(...args: Parameters<typeof original.runViteDoctor>) {
      const run = original.runViteDoctor(...args);
      doctorRuns.push(run.catch(() => undefined));
      return run;
    },
  };
});

const secretRule = "vite/env/no-client-secret-pattern";

async function withProject(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "doctor-plugin-serve-"));
  doctorRuns.length = 0;
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(
      join(root, "entry.ts"),
      "export const secret = import.meta.env.VITE_API_SECRET;\n",
    );
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
  const doctorLogs = () =>
    [...logs.info, ...logs.warn, ...logs.error].filter((message) =>
      /Doctor|vite\/env\//.test(message),
    );
  return { logger, logs, doctorLogs };
}

/** Holds the Doctor Run inside Project Inventory until released, recording when it started. */
function gatedInventory() {
  const entered: Array<{ listening: boolean | undefined }> = [];
  const gates: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
  let server: ViteDevServer | undefined;
  const extension: DoctorExtension = {
    name: "fixture/serve-gate",
    setup(api) {
      api.registerProjectInventoryContributor({
        name: "fixture-serve-gate",
        async contribute() {
          entered.push({ listening: server?.httpServer?.listening });
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
    entered,
    attach(target: ViteDevServer) {
      server = target;
    },
    release(index: number) {
      gates[index]!.resolve();
    },
  };
}

function serveConfig(
  root: string,
  logger: Logger,
  options: ViteDoctorSurfaceOptions,
  extra: InlineConfig = {},
): InlineConfig {
  return {
    root,
    configFile: false,
    customLogger: logger,
    plugins: [doctor({ run: "serve", rules: secretRule, cache: false, ...options })],
    server: { port: 0, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true },
    ...extra,
  };
}

test("a serve-mode Doctor Run starts after the dev server listens and logs Diagnostics", async () => {
  await withProject(async (root) => {
    const { logger, logs } = captureLogger();
    const gate = gatedInventory();
    const server = await createServer(serveConfig(root, logger, { extensions: [gate.extension] }));
    gate.attach(server);
    try {
      await server.listen();
      await vi.waitFor(() => expect(gate.entered).toHaveLength(1), { timeout: 15_000 });
      expect(gate.entered[0]!.listening).toBe(true);
      expect(logs.error).toEqual([]);

      gate.release(0);
      await vi.waitFor(() => expect(logs.error.join("\n")).toContain(secretRule), {
        timeout: 15_000,
      });
      const address = server.httpServer!.address() as { port: number };
      const response = await fetch(`http://localhost:${address.port}/entry.ts`);
      expect(response.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});

test("warn mode logs serve-mode Diagnostics as warnings", async () => {
  await withProject(async (root) => {
    const { logger, logs } = captureLogger();
    const server = await createServer(serveConfig(root, logger, { mode: "warn" }));
    try {
      await server.listen();
      await vi.waitFor(() => expect(logs.warn.join("\n")).toContain(secretRule), {
        timeout: 15_000,
      });
      expect(logs.error).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

test("a failing serve-mode Doctor Run is logged without stopping the dev server", async () => {
  await withProject(async (root) => {
    const { logger, logs } = captureLogger();
    const failing: DoctorExtension = {
      name: "fixture/failing-inventory",
      setup(api) {
        api.registerProjectInventoryContributor({
          name: "fixture-failing-inventory",
          contribute() {
            throw new Error("fixture inventory exploded");
          },
        });
      },
    };
    const server = await createServer(serveConfig(root, logger, { extensions: [failing] }));
    try {
      await server.listen();
      await vi.waitFor(
        () => expect(logs.error.join("\n")).toContain("fixture inventory exploded"),
        {
          timeout: 15_000,
        },
      );
      const address = server.httpServer!.address() as { port: number };
      expect((await fetch(`http://localhost:${address.port}/entry.ts`)).status).toBe(200);
    } finally {
      await server.close();
    }
  });
});

test("closing the dev server drops its in-flight serve-mode Doctor Run", async () => {
  await withProject(async (root) => {
    const { logger, doctorLogs } = captureLogger();
    const gate = gatedInventory();
    const server = await createServer(serveConfig(root, logger, { extensions: [gate.extension] }));
    gate.attach(server);
    await server.listen();
    await vi.waitFor(() => expect(gate.entered).toHaveLength(1), { timeout: 15_000 });

    await server.close();
    gate.release(0);
    await Promise.all(doctorRuns);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(doctorLogs()).toEqual([]);
  });
});

test("a dev server closed before it listens never starts a Doctor Run", async () => {
  await withProject(async (root) => {
    const { logger, doctorLogs } = captureLogger();
    const server = await createServer(serveConfig(root, logger, {}));
    await server.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(doctorRuns).toHaveLength(0);
    expect(doctorLogs()).toEqual([]);
  });
});

test("a restarted dev server supersedes the previous serve-mode Doctor Run", async () => {
  await withProject(async (root) => {
    const { logger, logs } = captureLogger();
    const gate = gatedInventory();
    const server = await createServer(serveConfig(root, logger, { extensions: [gate.extension] }));
    gate.attach(server);
    try {
      await server.listen();
      await vi.waitFor(() => expect(gate.entered).toHaveLength(1), { timeout: 15_000 });

      await server.restart();
      await vi.waitFor(() => expect(gate.entered).toHaveLength(2), { timeout: 15_000 });
      gate.release(1);
      await vi.waitFor(() => expect(logs.error.join("\n")).toContain(secretRule), {
        timeout: 15_000,
      });

      gate.release(0);
      await Promise.all(doctorRuns);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(doctorRuns).toHaveLength(2);
      expect(logs.error.filter((message) => message.includes(secretRule))).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});

test("middleware-mode dev servers return before their Doctor Run finishes", async () => {
  await withProject(async (root) => {
    const { logger, logs } = captureLogger();
    const gate = gatedInventory();
    const options = { extensions: [gate.extension] };
    const plugin = doctor({ run: "serve", rules: secretRule, cache: false, ...options });
    const shared = {
      root,
      configFile: false as const,
      customLogger: logger,
      plugins: [plugin],
      appType: "custom" as const,
      optimizeDeps: { noDiscovery: true },
    };
    const client = await createServer({
      ...shared,
      server: { middlewareMode: true, ws: false, watch: null },
    });
    const ssr = await createServer({
      ...shared,
      server: { middlewareMode: true, ws: false, watch: null },
      build: { ssr: join(root, "entry.ts") },
    });
    try {
      await vi.waitFor(() => expect(gate.entered).toHaveLength(1), { timeout: 15_000 });
      gate.release(0);
      await vi.waitFor(() => expect(logs.error.join("\n")).toContain(secretRule), {
        timeout: 15_000,
      });
      await Promise.all(doctorRuns);
      expect(doctorRuns).toHaveLength(1);
    } finally {
      await ssr.close();
      await client.close();
    }
  });
});

test("serve-mode support keeps build-mode failures in the host build", async () => {
  await withProject(async (root) => {
    await expect(
      build({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [doctor({ run: "both", rules: secretRule, cache: false })],
        build: { write: false, lib: { entry: join(root, "entry.ts"), formats: ["es"] } },
      }),
    ).rejects.toThrow(secretRule);
  });
});
