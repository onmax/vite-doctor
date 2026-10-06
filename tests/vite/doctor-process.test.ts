import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { main } from "../../src/cli.ts";
import {
  doctorProcessRoot,
  doctorProcessStatus,
  runThroughDoctorProcess,
  stopDoctorProcess,
  type DoctorProcessLaunch,
} from "../../src/doctor-process/client.ts";
import {
  doctorProcessPaths,
  readDoctorProcessState,
  requestDoctorProcess,
  type DoctorProcessResponse,
} from "../../src/doctor-process/protocol.ts";
import { serveDoctorProcess, type DoctorProcessServer } from "../../src/doctor-process/server.ts";
import { watchDoctorRuns } from "../../src/doctor-process/watch.ts";

const runs = vi.hoisted(() => ({ active: 0, max: 0 }));

vi.mock("../../src/cli-main.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/cli-main.ts")>();
  return {
    ...original,
    async main(...args: Parameters<typeof original.main>) {
      runs.max = Math.max(runs.max, ++runs.active);
      try {
        return await original.main(...args);
      } finally {
        runs.active--;
      }
    },
  };
});

const roots: string[] = [];
const launchers: InProcessLauncher[] = [];

afterEach(async () => {
  for (const launcher of launchers.splice(0)) await launcher.stopAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.VITE_DOCTOR_SERVER_IDLE_MS;
});

test("a Doctor Run starts the Doctor process once and reuses it", async () => {
  const root = await fixture(viteErrorFixture());
  const launcher = inProcessLauncher();

  const first = await viaProcess(launcher, [".", "--format", "json"], root);
  const second = await viaProcess(launcher, [".", "--format", "json"], root);

  expect(first.code).toBe(1);
  expect(second).toEqual(first);
  expect(launcher.launches).toHaveLength(1);
  const status = await doctorProcessStatus(root);
  expect(status).toMatchObject({ running: true, activity: { runs: 2 } });
  expect(status.state).not.toHaveProperty("token");
  expect(existsSync(join(root, ".vite-doctor/cache/store.json"))).toBe(true);
});

test("Doctor process output matches a direct run byte for byte", async () => {
  const root = await fixture(viteErrorFixture());
  const launcher = inProcessLauncher();
  const invocations = [
    [".", "--format", "text"],
    [".", "--format", "json"],
    [".", "--format", "agent"],
    [".", "--format", "sarif"],
    [".", "--format", "agent", "--max-warnings", "0", "--rules", "vite/**"],
    [".", "--format", "json", "--no-cache"],
    [".", "--format", "agent", "--changed"],
    [".", "--format", "bogus"],
    [".", "--format", "text", "--severity", "nope"],
  ];
  for (const args of invocations) {
    const direct = await captured(() => main(args, root));
    const served = await viaProcess(launcher, [...args, "--server"], root);
    expect(served, args.join(" ")).toEqual(direct);
  }
  expect(launcher.launches).toHaveLength(1);
});

test("a Doctor process with another identity is replaced", async () => {
  const root = await fixture(viteErrorFixture());
  const launcher = inProcessLauncher();

  await viaProcess(launcher, [".", "--format", "json"], root, "build-one");
  const replaced = launcher.servers[0]!;
  const result = await viaProcess(launcher, [".", "--format", "json"], root, "build-two");

  expect(result.code).toBe(1);
  expect(launcher.launches.map((launch) => launch.key)).toEqual(["build-one", "build-two"]);
  await replaced.closed;
  expect(readDoctorProcessState(doctorProcessPaths(root))?.key).toBe("build-two");
});

test("a Doctor process that died is replaced", async () => {
  const root = await fixture(viteErrorFixture());
  const launcher = inProcessLauncher();
  const paths = doctorProcessPaths(root);
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    paths.state,
    JSON.stringify({
      protocol: 1,
      pid: 1,
      root,
      key: "test",
      version: "0.0.0",
      node: process.version,
      socket: join(paths.directory, "gone.sock"),
      log: paths.log,
      token: "stale",
      startedAt: new Date().toISOString(),
      idleTimeoutMs: 1000,
    }),
  );

  const result = await viaProcess(launcher, [".", "--format", "json"], root);

  expect(result.code).toBe(1);
  expect(launcher.launches).toHaveLength(1);
  expect(readDoctorProcessState(paths)?.token).not.toBe("stale");
});

test("an idle Doctor process exits and removes its socket and state", async () => {
  const root = await fixture(viteErrorFixture());
  const launcher = inProcessLauncher();
  process.env.VITE_DOCTOR_SERVER_IDLE_MS = "100";

  await viaProcess(launcher, [".", "--format", "json"], root);
  await launcher.servers[0]!.closed;

  const paths = doctorProcessPaths(root);
  expect(existsSync(paths.state)).toBe(false);
  expect(existsSync(paths.socket)).toBe(false);
  expect(await doctorProcessStatus(root)).toMatchObject({ running: false });
});

test("server stop stops the Doctor process and reports when none runs", async () => {
  const root = await fixture(viteErrorFixture());
  const launcher = inProcessLauncher();
  await viaProcess(launcher, [".", "--format", "json"], root);
  const pid = readDoctorProcessState(doctorProcessPaths(root))?.pid;

  const running = await captured(() => main(["server", "status", ".", "--format", "json"], root));
  expect(running.code).toBe(0);
  expect(JSON.parse(running.stdout)).toMatchObject({ root, running: true, state: { pid } });
  const stopped = await captured(() => main(["server", "stop", "."], root));
  expect(stopped.code).toBe(0);
  expect(readDoctorProcessState(doctorProcessPaths(root))).toBeUndefined();
  await launcher.servers[0]!.closed;
  expect(await stopDoctorProcess(root)).toEqual({ stopped: false });

  const status = await captured(() => main(["server", "status", ".", "--format", "json"], root));
  expect(status.code).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({ root, running: false });
});

test("concurrent clients share one Doctor process and its runs never overlap", async () => {
  const root = await fixture(viteErrorFixture());
  const launcher = inProcessLauncher();
  const direct = await captured(() => main([".", "--format", "json"], root));

  const args = [".", "--format", "json"];
  await viaProcess(launcher, args, root);
  const state = readDoctorProcessState(doctorProcessPaths(root))!;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

  // Clients in one process would share process.stdout, so these talk to the socket directly.
  runs.max = 0;
  const responses = await Promise.all(
    [0, 1, 2].map(() =>
      requestDoctorProcess(state, {
        kind: "run",
        token: state.token,
        key: state.key,
        root,
        cwd: root,
        args,
        env,
      }),
    ),
  );

  expect(responses.map(decode)).toEqual([direct, direct, direct]);
  expect(launcher.servers).toHaveLength(1);
  expect(runs.max).toBe(1);
  const cache = await captured(() => main(["cache", "status", "--format", "json"], root));
  expect(JSON.parse(cache.stdout)).toMatchObject({ exists: true, compatible: true });
});

test("the Doctor process never loads executable config, even after a trusted run", async () => {
  const root = await fixture({
    ...viteErrorFixture(),
    "package.json": JSON.stringify({ type: "module", dependencies: { vite: "^7.0.0" } }),
    "doctor.config.ts": `import { writeFileSync } from "node:fs"
writeFileSync(new URL("./config-loaded", import.meta.url), String(process.pid))
export default { rules: { "vite/define/no-secret-define": "off" } }
`,
  });
  const launcher = inProcessLauncher();
  const args = [".", "--rules", "vite/define/no-secret-define", "--format", "json"];
  const trusted = [...args, "--config", "doctor.config.ts"];

  expect(await runThroughDoctorProcess(trusted, root, launcher.options())).toBeUndefined();
  expect(launcher.launches).toHaveLength(0);
  const direct = await captured(() => main(trusted, root));
  expect(JSON.parse(direct.stdout).diagnostics).toEqual([]);
  expect(existsSync(join(root, "config-loaded"))).toBe(true);
  rmSync(join(root, "config-loaded"));

  const served = await viaProcess(launcher, args, root);
  expect(JSON.parse(served.stdout).diagnostics).toEqual([
    expect.objectContaining({ rule: "vite/define/no-secret-define" }),
  ]);
  expect(await runThroughDoctorProcess(trusted, root, launcher.options())).toBeUndefined();
  const again = await viaProcess(launcher, args, root);
  expect(again).toEqual(served);

  const state = readDoctorProcessState(doctorProcessPaths(root))!;
  const request = { kind: "run", key: state.key, root, cwd: root, env: {} } as const;
  for (const forced of [trusted, [...args, "--host-extensions"]]) {
    expect(
      await requestDoctorProcess(state, { ...request, token: state.token, args: forced }),
    ).toMatchObject({ kind: "error" });
  }
  await expect(
    requestDoctorProcess(state, { ...request, token: "not-the-token", args }),
  ).rejects.toThrow();
  expect(existsSync(join(root, "config-loaded"))).toBe(false);
  expect(await doctorProcessStatus(root)).toMatchObject({ activity: { runs: 2 } });
});

test("only declarative Doctor Run invocations are served by the Doctor process", async () => {
  const root = await fixture(viteErrorFixture());
  mkdirSync(join(root, "apps/web"), { recursive: true });

  expect(doctorProcessRoot([], root)).toBe(root);
  expect(doctorProcessRoot(["apps/web", "--format=json", "--changed"], root)).toBe(
    join(root, "apps/web"),
  );
  expect(doctorProcessRoot(["--format", "agent", "--server", "."], root)).toBe(root);
  for (const args of [
    ["--config", "doctor.config.ts"],
    ["--config=doctor.config.ts"],
    ["--host-extensions"],
    ["--watch"],
    ["--help"],
    ["-h"],
    ["--unknown"],
    ["rules"],
    ["explain", "VITE0001"],
    ["cache", "status"],
    ["server", "status"],
    ["missing-directory"],
    [".", "apps/web"],
    ["--format"],
  ]) {
    expect(doctorProcessRoot(args, root), args.join(" ")).toBeUndefined();
  }
  expect(
    await runThroughDoctorProcess(["."], root, {
      ...inProcessLauncher().options(),
      interactive: true,
    }),
  ).toBeUndefined();
});

test("watch reruns Doctor through the long-lived engine when a project file changes", async () => {
  const root = await fixture(viteErrorFixture());
  const reports: Array<{ code: number; diagnostics: number }> = [];
  const controller = new AbortController();
  const watching = watchDoctorRuns({
    root,
    ignore: [join(root, ".vite-doctor/cache")],
    debounceMs: 20,
    signal: controller.signal,
    run: async () => {
      const result = await captured(() =>
        main([".", "--format", "json", "--rules", "vite/define/no-secret-define"], root),
      );
      reports.push({
        code: result.code,
        diagnostics: JSON.parse(result.stdout).diagnostics.length,
      });
      return result.code;
    },
  });

  await waitFor(() => reports.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(reports).toHaveLength(1);
  writeFileSync(join(root, "vite.config.ts"), "export default {}\n");
  await waitFor(() => reports.length === 2);
  controller.abort();

  expect(await watching).toBe(0);
  expect(reports).toEqual([
    { code: 1, diagnostics: 1 },
    { code: 0, diagnostics: 0 },
  ]);
});

test("watch rejects options that write project files", async () => {
  const root = await fixture(viteErrorFixture());
  const result = await captured(() => main([".", "--watch", "--fix", "--format", "agent"], root));
  expect(result.code).toBe(2);
  expect(JSON.parse(result.stdout).error.message).toContain("--watch cannot be combined");
});

interface InProcessLauncher {
  launches: DoctorProcessLaunch[];
  servers: DoctorProcessServer[];
  options(identity?: string): Parameters<typeof runThroughDoctorProcess>[2];
  stopAll(): Promise<void>;
}

function inProcessLauncher(): InProcessLauncher {
  const launcher: InProcessLauncher = {
    launches: [],
    servers: [],
    options: (identity = "test") => ({
      identity,
      interactive: false,
      start(launch) {
        launcher.launches.push(launch);
        const ready = serveDoctorProcess(launch).then((server) => {
          if (server) launcher.servers.push(server);
          return server;
        });
        return { exited: ready.then((server) => server?.closed) };
      },
    }),
    async stopAll() {
      await Promise.all(launcher.servers.map((server) => server.stop()));
    },
  };
  launchers.push(launcher);
  return launcher;
}

async function viaProcess(
  launcher: InProcessLauncher,
  args: string[],
  cwd: string,
  identity?: string,
) {
  return captured(async () => {
    const code = await runThroughDoctorProcess(args, cwd, launcher.options(identity));
    if (code === undefined) throw new Error(`Doctor process did not serve ${args.join(" ")}`);
    return code;
  });
}

function decode(response: DoctorProcessResponse) {
  if (response.kind !== "output") throw new Error(`Unexpected ${response.kind} response`);
  const text = (fd: number) =>
    response.output
      .filter(([target]) => target === fd)
      .map(([, chunk]) => Buffer.from(chunk, "base64").toString("utf8"))
      .join("");
  return { code: response.exitCode, stdout: text(1), stderr: text(2) };
}

async function captured(fn: () => Promise<number>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await fn();
    return { code, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vite-doctor-process-"));
  roots.push(root);
  for (const [file, contents] of Object.entries(files)) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return root;
}

function viteErrorFixture(): Record<string, string> {
  return {
    "package.json": JSON.stringify({ dependencies: { vite: "^7.0.0" } }),
    "vite.config.ts":
      "export default {\n  define: {\n    SECRET_KEY: JSON.stringify('secret'),\n  },\n}\n",
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
