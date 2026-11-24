import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { createServer, type Logger, type ViteDevServer } from "vite";
import { expect, test, vi } from "vite-plus/test";
import type { Diagnostic, DoctorRunResult } from "../../src/core/index.ts";
import { doctor } from "../../src/plugin.ts";

const doctorRuns = vi.hoisted(() => [] as Array<Promise<DoctorRunResult | undefined>>);

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

const CODE = "DOC0040";
const entry = `interface Options {
  key: string;
  lazy?: boolean;
}

export function load(options: Options) {
  return useAsyncData(options.key, () => fetchItems());
}
`;

async function withServer(run: (server: ViteDevServer, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "doctor-runtime-diagnostics-"));
  doctorRuns.length = 0;
  const silent: Logger = {
    info() {},
    warn() {},
    warnOnce() {},
    error() {},
    clearScreen() {},
    hasErrorLogged: () => false,
    hasWarned: false,
  };
  let server: ViteDevServer | undefined;
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(root, "entry.ts"), entry);
    server = await createServer({
      root,
      configFile: false,
      customLogger: silent,
      plugins: [doctor({ run: "serve", rules: "vite/env/no-client-secret-pattern", cache: false })],
      server: { port: 0, watch: null },
      optimizeDeps: { noDiscovery: true },
    });
    await server.listen();
    await run(server, root);
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
}

function origin(server: ViteDevServer) {
  return `http://localhost:${(server.httpServer!.address() as { port: number }).port}`;
}

/** A browser tab connected to the dev server's HMR WebSocket. */
async function connectClient(server: ViteDevServer) {
  const socket = new WebSocket(`${origin(server).replace("http", "ws")}/`, "vite-hmr");
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return {
    send(data: unknown) {
      socket.send(JSON.stringify({ type: "custom", event: "nostics:report", data }));
    },
    close: () => socket.close(),
  };
}

async function latestRun(): Promise<DoctorRunResult> {
  const results = await Promise.all(doctorRuns);
  return results.findLast((result) => result !== undefined)!;
}

async function runtimeDiagnostics(): Promise<Diagnostic[]> {
  return (await latestRun()).diagnostics.filter((diagnostic) => diagnostic.code === CODE);
}

async function waitForRuntimeDiagnostics(count: number): Promise<Diagnostic[]> {
  let diagnostics: Diagnostic[] = [];
  await vi.waitFor(
    async () => {
      diagnostics = await runtimeDiagnostics();
      expect(diagnostics).toHaveLength(count);
    },
    { timeout: 15_000, interval: 100 },
  );
  return diagnostics;
}

/** The line and column, both 1-based, of `needle` in the code Vite serves for `path`. */
async function servedPosition(server: ViteDevServer, path: string, needle: string) {
  const code = await (await fetch(`${origin(server)}${path}`)).text();
  const lines = code.split("\n");
  const line = lines.findIndex((text) => text.includes(needle));
  return { line: line + 1, column: lines[line]!.indexOf(needle) + 1 };
}

const asyncDataReport = (source?: string) => ({
  name: "NUXT_E3004",
  why: "`useAsyncData` was called with the key `items` and a different handler.",
  fix: "Use a unique key for each `useAsyncData` call.",
  docs: "https://nuxt.com/docs/4.x/errors/e3004",
  sources: source ? [source] : undefined,
  stack: "Error: `useAsyncData` was called with the key `items`",
});

test("a nostics report from the browser becomes a DOC0040 Diagnostic at the source call site", async () => {
  await withServer(async (server, root) => {
    await vi.waitFor(() => expect(doctorRuns).toHaveLength(1), { timeout: 15_000 });
    expect(await runtimeDiagnostics()).toEqual([]);

    const { line, column } = await servedPosition(server, "/entry.ts", "useAsyncData(");
    // The served code drops the interface, so only the source map leads back to line 7.
    expect(line).not.toBe(7);
    const client = await connectClient(server);
    try {
      client.send(asyncDataReport(`${origin(server)}/entry.ts?t=1700000000000:${line}:${column}`));
      const [diagnostic] = await waitForRuntimeDiagnostics(1);
      expect(diagnostic).toMatchObject({
        ruleId: "doctor/runtime/framework-diagnostic",
        severity: "warn",
        confidence: "runtime-backed",
        file: join(root, "entry.ts"),
        range: { line: 7, column: 10 },
        sources: [`${join(root, "entry.ts")}:7:10`],
      });
      expect(diagnostic!.message).toContain("NUXT_E3004");
      expect(diagnostic!.message).toContain("a different handler");
      expect(diagnostic!.suggestion).toContain("Use a unique key");
      expect(diagnostic!.suggestion).toContain("https://nuxt.com/docs/4.x/errors/e3004");
    } finally {
      client.close();
    }
  });
});

test("a report without a call site Doctor can map stays at the project root with partial location evidence", async () => {
  await withServer(async (server, root) => {
    await vi.waitFor(() => expect(doctorRuns).toHaveLength(1), { timeout: 15_000 });
    const client = await connectClient(server);
    try {
      client.send({
        name: "NUXT_E4007",
        why: "Your project has layouts but the `<NuxtLayout />` component has not been used.",
        fix: "Add `<NuxtLayout />` to `app.vue`.",
      });
      client.send(asyncDataReport(`${origin(server)}/missing.ts:3:1`));
      const diagnostics = await waitForRuntimeDiagnostics(2);
      for (const diagnostic of diagnostics) {
        expect(diagnostic.file).toBe(root);
        expect(diagnostic.range).toBeUndefined();
        expect(diagnostic.evidence?.map((item) => item.summary).join("\n")).toMatch(
          /did not map|no call site/,
        );
      }
      const unmapped = diagnostics.find((diagnostic) => diagnostic.message.includes("NUXT_E3004"));
      expect(unmapped?.evidence?.map((item) => item.summary).join("\n")).toContain(
        "/missing.ts:3:1",
      );
    } finally {
      client.close();
    }
  });
});

test("malformed nostics payloads report nothing", async () => {
  await withServer(async (server) => {
    await vi.waitFor(() => expect(doctorRuns).toHaveLength(1), { timeout: 15_000 });
    const client = await connectClient(server);
    try {
      for (const payload of [
        undefined,
        "NUXT_E3004",
        { why: "missing name" },
        { name: 3004, why: "numeric name" },
        { name: "NUXT_E3004" },
        { name: "NUXT_E3004", why: "bad sources", sources: "entry.ts:1:1" },
        { name: "NUXT_E3004", why: "bad fix", fix: 1 },
        { name: "not a code", why: "spaces in the name" },
      ])
        client.send(payload);
      client.send({
        name: "NUXT_E4011",
        why: "Your project has pages but `<NuxtPage />` is unused.",
      });
      const [diagnostic] = await waitForRuntimeDiagnostics(1);
      expect(diagnostic!.message).toContain("NUXT_E4011");
    } finally {
      client.close();
    }
  });
});

test("a repeated nostics report is reported once", async () => {
  await withServer(async (server) => {
    await vi.waitFor(() => expect(doctorRuns).toHaveLength(1), { timeout: 15_000 });
    const { line, column } = await servedPosition(server, "/entry.ts", "useAsyncData(");
    const client = await connectClient(server);
    try {
      for (const timestamp of [1, 2, 3])
        client.send(asyncDataReport(`${origin(server)}/entry.ts?t=${timestamp}:${line}:${column}`));
      client.send({
        name: "NUXT_E4011",
        why: "Your project has pages but `<NuxtPage />` is unused.",
      });
      const diagnostics = await waitForRuntimeDiagnostics(2);
      expect(diagnostics.map((diagnostic) => diagnostic.message.split(":")[0]).sort()).toEqual([
        "NUXT_E3004",
        "NUXT_E4011",
      ]);
    } finally {
      client.close();
    }
  });
});

test("saving the reported file drops its runtime report until the runtime reports it again", async () => {
  await withServer(async (server, root) => {
    await vi.waitFor(() => expect(doctorRuns).toHaveLength(1), { timeout: 15_000 });
    const { line, column } = await servedPosition(server, "/entry.ts", "useAsyncData(");
    const client = await connectClient(server);
    try {
      client.send(asyncDataReport(`${origin(server)}/entry.ts:${line}:${column}`));
      await waitForRuntimeDiagnostics(1);
      server.watcher.emit("change", join(root, "entry.ts"));
      await waitForRuntimeDiagnostics(0);
    } finally {
      client.close();
    }
  });
});
