import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, createBuilder, type InlineConfig, type Logger } from "vite";
import { expect, test, vi } from "vite-plus/test";
import { runViteDoctor } from "../../src/doctor.ts";
import { doctor } from "../../src/plugin.ts";

const rule = "vite/build/no-node-builtin-in-client-chunk";

const db = [
  'import { readFileSync } from "node:fs";',
  "export function loadUsers() {",
  '  return JSON.parse(readFileSync("users.json", "utf8"));',
  "}",
  "",
].join("\n");

async function withProject(
  files: Record<string, string>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "doctor-build-evidence-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(
      join(root, "index.html"),
      '<script type="module" src="/src/main.ts"></script>\n',
    );
    for (const [file, content] of Object.entries(files)) {
      await mkdir(join(root, file, ".."), { recursive: true });
      await writeFile(join(root, file), content);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function capture(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const logger: Logger = {
    hasWarned: false,
    info() {},
    warn(message) {
      warnings.push(message);
    },
    warnOnce(message) {
      warnings.push(message);
    },
    error() {},
    clearScreen() {},
    hasErrorLogged: () => false,
  };
  return { logger, warnings };
}

function config(root: string, logger: Logger, options: InlineConfig = {}): InlineConfig {
  return {
    root,
    configFile: false,
    customLogger: logger,
    plugins: [doctor({ rules: rule, cache: false })],
    ...options,
    build: { write: false, ...options.build },
  };
}

test("reports a server module that a client entry pulls into its chunk", async () => {
  await withProject(
    {
      "src/main.ts": 'import { loadUsers } from "./users";\nconsole.log(loadUsers());\n',
      "src/users.ts": 'export { loadUsers } from "./db";\n',
      "src/db.ts": db,
    },
    async (root) => {
      const { logger, warnings } = capture();
      await build(config(root, logger));
      const report = warnings.join("\n");
      expect(report).toContain("VITE0033");
      expect(report).toContain(rule);
      expect(report).toContain("src/db.ts:1:");
      expect(report).toContain("src/main.ts → src/users.ts → src/db.ts");
    },
  );
});

test("fails the build in error mode when the rule is set to error", async () => {
  await withProject(
    {
      "src/main.ts": 'import { loadUsers } from "./db";\nconsole.log(loadUsers());\n',
      "src/db.ts": db,
    },
    async (root) => {
      const { logger } = capture();
      const options = config(root, logger);
      options.plugins = [
        doctor({ rules: rule, cache: false, config: { rules: { [rule]: "error" } } }),
      ];
      await expect(build(options)).rejects.toThrow(rule);
    },
  );
});

test("stays quiet when only the server environment bundles the module", async () => {
  await withProject(
    {
      "src/main.ts": 'console.log("client");\n',
      "src/server.ts": 'import { loadUsers } from "./db";\nexport const users = loadUsers();\n',
      "src/db.ts": db,
    },
    async (root) => {
      const { logger, warnings } = capture();
      const builder = await createBuilder({
        ...config(root, logger),
        builder: { sharedPlugins: true },
        environments: {
          ssr: { consumer: "server", build: { ssr: join(root, "src/server.ts") } },
        },
      });
      await builder.buildApp();
      expect(warnings.join("\n")).not.toContain("VITE0033");
    },
  );
});

test("stays quiet when the bundler drops the server branch from the client chunk", async () => {
  await withProject(
    {
      "src/main.ts": [
        'import { readFileSync } from "node:fs";',
        "export function load() {",
        '  if (import.meta.env.SSR) return readFileSync("users.json", "utf8");',
        '  return "client";',
        "}",
        "console.log(load());",
        "",
      ].join("\n"),
    },
    async (root) => {
      const { logger, warnings } = capture();
      await build(config(root, logger));
      expect(warnings.join("\n")).not.toContain("VITE0033");
    },
  );
});

const deadFs = [
  'import { readFileSync } from "node:fs";',
  'if (import.meta.env.SSR) console.log(readFileSync("users.json"));',
].join("\n");

test("does not mistake a surviving browser:false stub for a dead builtin import", async () => {
  vi.stubEnv("NODE_ENV", "production");
  try {
    await withProject(
      {
        "src/main.ts": `${deadFs}\nimport disabled from "disabled";\nconsole.log(disabled);`,
        "node_modules/disabled/package.json":
          '{"name":"disabled","main":"index.js","browser":{"./index.js":false}}',
        "node_modules/disabled/index.js": "module.exports = 'server';",
      },
      async (root) => {
        const { logger, warnings } = capture();
        await build(config(root, logger));
        expect(warnings.join("\n")).not.toContain("VITE0033");
      },
    );
  } finally {
    vi.unstubAllEnvs();
  }
});

test("names and locates only the live builtin sharing the production stub", async () => {
  vi.stubEnv("NODE_ENV", "production");
  try {
    await withProject(
      {
        "src/main.ts": `${deadFs}\nimport crypto from "node:crypto";\nconsole.log(crypto.randomUUID());`,
      },
      async (root) => {
        const { logger, warnings } = capture();
        await build(config(root, logger));
        const [report] = warnings.filter((warning) => warning.includes("VITE0033"));
        expect(report).toContain("'node:crypto'");
        expect(report).toContain("src/main.ts:3:");
        expect(report).not.toContain("'node:fs'");
      },
    );
  } finally {
    vi.unstubAllEnvs();
  }
});

test("reports a surviving dynamic import without publishing internal source maps", async () => {
  await withProject({ "src/main.ts": 'console.log(import("node:fs"));' }, async (root) => {
    const { logger, warnings } = capture();
    const result = await build(config(root, logger));
    expect(warnings.join("\n")).toContain("VITE0033");
    expect(result).toHaveProperty("output");
    if ("output" in result) {
      expect(result.output.some((item) => item.fileName.endsWith(".map"))).toBe(false);
      expect(result.output.every((item) => item.type !== "chunk" || item.map === null)).toBe(true);
    }
  });
});

test("stays quiet for a dead builtin and a stub-like string in UMD", async () => {
  await withProject(
    { "src/main.ts": `${deadFs}\nconsole.log("viteBrowserExternal");` },
    async (root) => {
      const { logger, warnings } = capture();
      await build(
        config(root, logger, {
          build: { minify: false, lib: { entry: "src/main.ts", name: "test", formats: ["umd"] } },
        }),
      );
      expect(warnings.join("\n")).not.toContain("VITE0033");
    },
  );
});

test("ignores a stub read replaced by renderChunk", async () => {
  await withProject(
    { "src/main.ts": 'import fs from "node:fs";\nconsole.log(fs.readFileSync("x"));' },
    async (root) => {
      const { logger, warnings } = capture();
      const options = config(root, logger);
      await build({
        ...options,
        plugins: [
          options.plugins,
          {
            name: "replace-chunk",
            renderChunk: () => 'console.log("client");',
          },
        ],
      });
      expect(warnings.join("\n")).not.toContain("VITE0033");
    },
  );
});

test("reports the same warning only once across library formats", async () => {
  await withProject(
    { "src/main.ts": 'import fs from "node:fs";\nconsole.log(fs.readFileSync("x"));' },
    async (root) => {
      const { logger, warnings } = capture();
      await build(
        config(root, logger, {
          plugins: [doctor({ rules: rule, cache: false, maxWarnings: 1 })],
          build: { lib: { entry: "src/main.ts", name: "test", formats: ["es", "umd"] } },
        }),
      );
      expect(warnings.filter((warning) => warning.includes("VITE0033"))).toHaveLength(1);
    },
  );
});

test("reports each client environment separately without repeating previous outputs", async () => {
  const source = 'import fs from "node:fs";\nconsole.log(fs.readFileSync("x"));';
  await withProject({ "src/main.ts": source, "src/other.ts": source }, async (root) => {
    const { logger, warnings } = capture();
    const builder = await createBuilder({
      ...config(root, logger),
      builder: { sharedPlugins: true },
      environments: {
        other: {
          consumer: "client",
          build: { rolldownOptions: { input: join(root, "src/other.ts") } },
        },
      },
    });
    await builder.build(builder.environments.client);
    await builder.build(builder.environments.other);
    const reports = warnings.filter((warning) => warning.includes("VITE0033"));
    expect(reports).toHaveLength(2);
    expect(reports[0]).toContain("src/main.ts:1:");
    expect(reports[1]).toContain("src/other.ts:1:");
    expect(reports[1]).not.toContain("src/main.ts");
  });
});

test.each(["error", "warn"] as const)(
  "shares a warning budget across phases in %s mode",
  async (mode) => {
    const envRule = "vite/env/no-client-secret-pattern";
    await withProject(
      {
        "src/main.ts":
          'import fs from "node:fs";\nconsole.log(import.meta.env.VITE_SECRET_KEY, fs.readFileSync("x"));',
      },
      async (root) => {
        const { logger, warnings } = capture();
        const result = build(
          config(root, logger, {
            plugins: [
              doctor({
                mode,
                rules: `${envRule},${rule}`,
                cache: false,
                maxWarnings: 1,
                config: { rules: { [envRule]: "warn" } },
              }),
            ],
          }),
        );
        if (mode === "error") await expect(result).rejects.toThrow("VITE0033");
        else {
          await result;
          expect(warnings.join("\n")).toContain("VITE0033");
        }
        expect(warnings.join("\n")).toContain("VITE0009");
      },
    );
  },
);

function stubEvidence(root: string, consumer: "client" | "server" | undefined, chain = true) {
  return {
    build: {
      root,
      environments: [
        {
          name: "client",
          ...(consumer ? { consumer } : {}),
          chunks: [
            { fileName: "assets/index.js", isEntry: true, modules: ["src/main.ts", "src/db.ts"] },
          ],
          entries: chain ? ["src/main.ts"] : [],
          importers: chain ? { "src/db.ts": ["src/main.ts"], "src/main.ts": [] } : {},
          browserStubReads: [
            { id: "src/db.ts", chunk: "assets/index.js", specifier: "node:fs", start: 0 },
          ],
        },
      ],
    },
  };
}

async function runWithEvidence(root: string, evidence: Record<string, unknown>) {
  return runViteDoctor({
    root,
    rules: rule,
    cache: false,
    extensions: [
      {
        name: "fixture/build-evidence",
        setup(api) {
          api.registerRuntimeEvidenceContributor({ name: "vite", contribute: () => evidence });
        },
      },
    ],
  });
}

test.each([
  ["no environment consumer", undefined],
  ["a server consumer", "server"],
] as const)("stays quiet for Build Evidence with %s", async (_label, consumer) => {
  await withProject(
    { "src/main.ts": 'import { loadUsers } from "./db";\nloadUsers();\n', "src/db.ts": db },
    async (root) => {
      const result = await runWithEvidence(root, stubEvidence(root, consumer));
      expect(result.diagnostics).toEqual([]);
    },
  );
});

test("stays quiet without Build Evidence or when the stub module imports no Node built-in", async () => {
  await withProject(
    {
      "src/main.ts": 'import { loadUsers } from "./db";\nloadUsers();\n',
      "src/db.ts":
        'import pkg from "browser-false-package";\nexport const loadUsers = () => pkg;\n',
    },
    async (root) => {
      expect((await runViteDoctor({ root, rules: rule, cache: false })).diagnostics).toEqual([]);
      const result = await runWithEvidence(root, stubEvidence(root, "client"));
      expect(result.diagnostics).toEqual([]);
    },
  );
});

test("says the evidence is partial when Vite's graph has no chain from an entry", async () => {
  await withProject(
    { "src/main.ts": 'import { loadUsers } from "./db";\nloadUsers();\n', "src/db.ts": db },
    async (root) => {
      const result = await runWithEvidence(root, stubEvidence(root, "client", false));
      expect(result.diagnostics.map(({ code }) => code)).toEqual(["VITE0033"]);
      const [diagnostic] = result.diagnostics;
      expect(diagnostic?.related).toBeUndefined();
      expect(diagnostic?.evidence?.map(({ summary }) => summary).join("\n")).toContain(
        "Evidence is partial",
      );
    },
  );
});
