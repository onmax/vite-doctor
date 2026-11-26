import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, createServer, type InlineConfig, type Logger, type Plugin } from "vite";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { readMcpServers } from "../../src/mcp/evidence.ts";
import { doctor, type ViteDoctorSurfaceOptions } from "../../src/plugin.ts";
import { runViteDoctor } from "../../src/doctor.ts";
import { defineDoctorExtension } from "../../src/extension.ts";
import { mcpStubHandler, startMcpStub, stubTools } from "../mcp/mcp-stub.ts";
import { mockReportReaderMcp, reportReaderMcpUrl, stubReaderEnv } from "../report-reader-env.ts";

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

afterEach(() => {
  vi.unstubAllEnvs();
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
  const infos: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const logger: Logger = {
    info: (message) => void infos.push(message),
    warn: (message) => void warnings.push(message),
    warnOnce() {},
    error: (message) => void errors.push(message),
    clearScreen() {},
    hasErrorLogged: () => false,
    hasWarned: false,
  };
  return { logger, errors, warnings, infos };
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
    const mcp = [{ url: "/live" }, { url: "/unavailable" }];
    const server = await createServer({
      ...config(root, logger, { run: "serve", mcp }),
      plugins: [
        {
          name: "fixture/live-mcp",
          configureServer(server) {
            server.middlewares.use("/unavailable", (_request, response) => {
              response.writeHead(401).end();
            });
            server.middlewares.use("/live", (request, response) => {
              if (!authorized) response.writeHead(401).end();
              else handler(request, response);
            });
          },
        },
        doctor({ cache: false, mode: "error", run: "serve", mcp }),
      ],
    });
    try {
      await server.listen();
      await vi.waitFor(() => expect(errors.join("\n")).toContain("HTTP 401"), { timeout: 15_000 });
      authorized = true;
      server.watcher.emit("change", join(root, "entry.ts"));
      await vi.waitFor(
        () => {
          expect(
            [...warnings, ...errors].some(
              (message) => message.includes("Evidence restored:") && message.includes("MCP0005"),
            ),
          ).toBe(true);
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

test("dev refreshes project findings as Extension MCP evidence appears and disappears", async () => {
  await withProject(async (root) => {
    const toggle = join(root, "toggle.ts");
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    const extension = defineDoctorExtension({
      name: "fixture/mcp-contributor",
      setup(api) {
        api.registerRuntimeEvidenceContributor({
          name: "fixture-mcp",
          async contribute() {
            const present = await access(toggle).then(
              () => true,
              () => false,
            );
            return present
              ? {
                  mcpServers: [
                    {
                      name: "remote",
                      tools: [
                        {
                          name: "search",
                          inputSchema: { type: "object", properties: { "page size": {} } },
                        },
                      ],
                    },
                  ],
                }
              : {};
          },
        });
      },
    });
    const { logger, infos, warnings } = captureLogger();
    const options = { cache: false, extensions: [extension] };
    const server = await createServer({
      ...config(root, logger, { run: "serve", ...options }),
      server: { middlewareMode: true, ws: false, watch: null },
    });
    try {
      await vi.waitFor(() => expect(infos.join("\n")).toContain("Summary"), { timeout: 15_000 });
      await writeFile(toggle, "export const present = true;\n");
      server.watcher.emit("add", toggle);
      await vi.waitFor(() => expect(warnings.join("\n")).toContain("MCP0005"), { timeout: 3_000 });
      await rm(toggle);
      server.watcher.emit("unlink", toggle);
      await vi.waitFor(() => expect(infos.join("\n")).toContain("resolved: MCP0005"), {
        timeout: 3_000,
      });
      const fresh = await runViteDoctor({ root, ...options });
      expect(fresh.diagnostics.map(({ code }) => code)).not.toContain("MCP0005");
    } finally {
      await server.close();
    }
  });
});

test("a build report keeps to the Report Budget and names plugin options to see more", async () => {
  stubReaderEnv({ AI_AGENT: "test-agent" });
  const fixture = JSON.parse(
    await readFile(new URL("../fixtures/mcp/nuxt.json", import.meta.url), "utf8"),
  );
  const stub = await startMcpStub({ tools: fixture.tools });
  try {
    await withProject(async (root) => {
      const { logger, warnings } = captureLogger();
      await build({
        ...config(root, logger, {
          run: "build",
          extends: ["auto", "mcp/strict"],
          format: "text",
          mcp: [{ url: stub.url }],
        }),
        build: { write: false, lib: { entry: "entry.ts", formats: ["es"] } },
      });
      const report = warnings.find((message) => message.includes("MCP0001"));
      expect(report).toBeDefined();
      expect(report!.length).toBeLessThanOrEqual(8000);
      expect(report).toContain(
        "More: apply the group's options, or set maxChars: Infinity in the Doctor plugin options",
      );
      expect(report).toMatch(/^ {2}more: rules: "mcp\//m);
      expect(report).not.toContain("vite-doctor .");
    });
  } finally {
    await stub.close();
  }
});

async function buildCiReport(options: ViteDoctorSurfaceOptions = {}) {
  const fetch = mockReportReaderMcp();
  try {
    let report: string | undefined;
    await withProject(async (root) => {
      const { logger, warnings } = captureLogger();
      await build({
        ...config(root, logger, {
          run: "build",
          extends: ["auto", "mcp/strict"],
          mcp: [{ url: reportReaderMcpUrl }],
          ...options,
        }),
        build: { write: false, lib: { entry: "entry.ts", formats: ["es"] } },
      });
      report = warnings.find((message) => message.includes("MCP0001"));
    });
    expect(report).toBeDefined();
    return report!;
  } finally {
    fetch.mockRestore();
  }
}

test("a CI build prints the complete report without pointing at more", async () => {
  stubReaderEnv({ CI: "1" });
  const report = await buildCiReport();
  expect(report.length).toBeGreaterThan(8000);
  expect(report).not.toContain("maxChars: Infinity");
  expect(report).not.toMatch(/^ {2}more: /m);
});

test("a CI build run by an agent defaults to the budgeted agent report", async () => {
  stubReaderEnv({ CI: "1", CLAUDECODE: "1" });
  const report = await buildCiReport();
  expect(JSON.parse(report).schema).toBe("vite-doctor.agent/v3");
  expect(report.length).toBeLessThanOrEqual(8000);
});

test("a CI build run by an agent keeps explicit format and budget options", async () => {
  stubReaderEnv({ CI: "1", CLAUDECODE: "1" });
  const report = await buildCiReport({ format: "text", maxChars: 4000 });
  expect(report.length).toBeLessThanOrEqual(4000);
  expect(report).toMatch(/^ {2}more: /m);
});
