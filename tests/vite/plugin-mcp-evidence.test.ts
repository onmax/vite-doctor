import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, createServer, type InlineConfig, type Logger, type Plugin } from "vite";
import { expect, test, vi } from "vite-plus/test";
import { readMcpServers } from "../../src/mcp/evidence.ts";
import { doctor, type ViteDoctorSurfaceOptions } from "../../src/plugin.ts";
import type { runViteDoctor } from "../../src/doctor.ts";
import { mcpStubHandler, stubTools } from "../mcp/mcp-stub.ts";

type RunResult = Awaited<ReturnType<typeof runViteDoctor>>;
const doctorRuns = vi.hoisted(() => [] as Array<Promise<RunResult>>);

vi.mock("../../src/doctor.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/doctor.ts")>();
  return {
    ...original,
    runViteDoctor(...args: Parameters<typeof original.runViteDoctor>) {
      const run = original.runViteDoctor(...args);
      doctorRuns.push(run);
      return run;
    },
  };
});

async function withProject(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "doctor-plugin-mcp-"));
  doctorRuns.length = 0;
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ type: "module", dependencies: { "@modelcontextprotocol/sdk": "^1.32.0" } }),
    );
    await writeFile(join(root, "entry.ts"), "export const ok = 1;\n");
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function captureLogger() {
  const errors: string[] = [];
  const warnings: string[] = [];
  const logger: Logger = {
    info() {},
    warn: (message) => void warnings.push(message),
    warnOnce() {},
    error: (message) => void errors.push(message),
    clearScreen() {},
    hasErrorLogged: () => false,
    hasWarned: false,
  };
  return { logger, errors, warnings };
}

const mcpEndpoint: Plugin = {
  name: "fixture/mcp-endpoint",
  configureServer(server) {
    const handler = mcpStubHandler();
    server.middlewares.use("/mcp", (request, response) => handler(request, response));
  },
};

function config(root: string, logger: Logger, options: ViteDoctorSurfaceOptions): InlineConfig {
  return {
    root,
    configFile: false,
    customLogger: logger,
    plugins: [mcpEndpoint, doctor({ cache: false, mode: "warn", ...options })],
    server: { port: 0, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true },
    logLevel: "silent",
  };
}

test("in dev, an MCP path resolves against the dev server once it listens", async () => {
  await withProject(async (root) => {
    const { logger, errors } = captureLogger();
    const server = await createServer(
      config(root, logger, { run: "serve", mcp: [{ url: "/mcp" }] }),
    );
    try {
      await server.listen();
      await vi.waitFor(() => expect(doctorRuns).toHaveLength(1), { timeout: 15_000 });
      const result = await doctorRuns[0]!;
      const origin = new URL(server.resolvedUrls!.local[0]!).origin;
      expect(readMcpServers(result.project.runtimeEvidence)).toEqual([
        expect.objectContaining({ url: origin, name: "stub", tools: stubTools }),
      ]);
      expect(result.project.evidenceGaps ?? []).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

test("in middleware mode, an MCP path is a config error that names Nuxt", async () => {
  await withProject(async (root) => {
    const { logger, errors } = captureLogger();
    const server = await createServer({
      ...config(root, logger, { run: "serve", mcp: [{ url: "/mcp" }] }),
      server: { middlewareMode: true, ws: false, watch: null },
    });
    try {
      await vi.waitFor(() => expect(errors).toHaveLength(1), { timeout: 15_000 });
      expect(errors[0]).toContain("MCP server URL is a path");
      expect(errors[0]).toContain("middleware mode, as under Nuxt");
      expect(doctorRuns).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

test("a save replaces project-wide MCP evidence gaps and findings", async () => {
  await withProject(async (root) => {
    const { logger, errors, warnings } = captureLogger();
    let authorized = false;
    const handler = mcpStubHandler({
      tools: [{ name: "remote", inputSchema: { type: "object", properties: { "page size": {} } } }],
    });
    const server = await createServer({
      ...config(root, logger, { run: "serve", mcp: [{ url: "/live" }] }),
      plugins: [
        {
          name: "fixture/live-mcp",
          configureServer(server) {
            server.middlewares.use("/live", (request, response) => {
              if (!authorized) response.writeHead(401).end();
              else handler(request, response);
            });
          },
        },
        doctor({ cache: false, mode: "error", run: "serve", mcp: [{ url: "/live" }] }),
      ],
    });
    try {
      await server.listen();
      await vi.waitFor(() => expect(errors.join("\n")).toContain("HTTP 401"), { timeout: 15_000 });
      authorized = true;
      server.watcher.emit("change", join(root, "entry.ts"));
      await vi.waitFor(
        () => {
          expect([...warnings, ...errors]).toContainEqual(
            expect.stringMatching(/Evidence restored:[\s\S]*MCP0005/),
          );
        },
        { timeout: 15_000 },
      );
    } finally {
      await server.close();
    }
  });
});

test("in a build, an MCP path is a config error", async () => {
  await withProject(async (root) => {
    const { logger } = captureLogger();
    await expect(
      build({
        ...config(root, logger, { run: "build", mcp: [{ url: "/mcp" }] }),
        build: { write: false, lib: { entry: "entry.ts", formats: ["es"] } },
      }),
    ).rejects.toThrow("a build has no dev server to resolve it against");
  });
});
