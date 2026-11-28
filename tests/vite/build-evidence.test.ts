import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, createBuilder, type InlineConfig, type Logger } from "vite";
import { expect, test, vi } from "vite-plus/test";
import { runViteDoctor } from "../../src/doctor.ts";
import { doctor, type ViteDoctorSurfaceOptions } from "../../src/plugin.ts";

const rule = "vite/build/no-node-builtin-in-client-chunk";
const liveFs = 'import fs from "node:fs";\nconsole.log(fs.readFileSync("x"));';

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

test("agent recovery reruns the build with the original Build Evidence", async () => {
  await withProject({ "src/main.ts": liveFs }, async (root) => {
    const run = async (maxChars: number) => {
      const { logger, warnings } = capture();
      await build(
        config(root, logger, {
          plugins: [doctor({ rules: rule, cache: false, format: "agent", maxChars })],
        }),
      );
      return JSON.parse(
        warnings.find((warning) => warning.includes('"schema":"vite-doctor.agent/v3"'))!,
      );
    };
    const compact = await run(1024);
    expect(compact.codes.VITE0033).toBe(1);
    expect(compact.budget.hidden.detail).toBe(1);
    expect(compact.commandArgs).toBeUndefined();
    expect(compact.pluginOptions.full).toEqual({ maxChars: "Infinity" });
    const full = await run(Number(compact.pluginOptions.full.maxChars));
    expect(full.budget).toBeUndefined();
    expect(full.groups[0]).toMatchObject({
      code: "VITE0033",
      diagnostics: [
        {
          evidence: expect.arrayContaining([
            expect.objectContaining({ kind: "runtime", path: "src/main.ts" }),
          ]),
        },
      ],
    });
  });
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

test("counts identical warnings in distinct client environments toward the budget", async () => {
  await withProject({ "src/main.ts": liveFs }, async (root) => {
    const { logger, warnings } = capture();
    const builder = await createBuilder({
      ...config(root, logger, { plugins: [doctor({ rules: rule, cache: false, maxWarnings: 1 })] }),
      environments: { other: { consumer: "client" } },
    });
    await expect(builder.buildApp()).rejects.toThrow("VITE0033");
    expect(warnings.filter((warning) => warning.includes("VITE0033"))).toHaveLength(1);
  });
});

test("enforces VITE0033 with an empty output plugin list", async () => {
  await withProject({ "src/main.ts": liveFs }, async (root) => {
    const { logger } = capture();
    await expect(
      build(
        config(root, logger, {
          plugins: [doctor({ rules: rule, cache: false, config: { rules: { [rule]: "error" } } })],
          build: { rolldownOptions: { output: { plugins: [] } } },
        }),
      ),
    ).rejects.toThrow("VITE0033");
  });
});

test("explains how to enable VITE0033 when a later output hook prevents private maps", async () => {
  await withProject({ "src/main.ts": liveFs }, async (root) => {
    const { logger, warnings } = capture();
    const options = config(root, logger, {
      plugins: [doctor({ rules: rule, cache: false, config: { rules: { [rule]: "error" } } })],
    });
    options.plugins?.push({
      name: "host-asset-names",
      outputOptions: {
        order: "post",
        handler: (output) => ({ ...output, assetFileNames: "assets/[name][extname]" }),
      },
    });
    const result = await build(options);
    expect(warnings.join("\n")).toContain("VITE0033 verification skipped");
    expect(warnings.join("\n")).toContain('build.sourcemap: "hidden"');
    expect("output" in result && result.output.some((item) => item.fileName.endsWith(".map"))).toBe(
      false,
    );
    await expect(
      build({ ...options, build: { ...options.build, sourcemap: "hidden" } }),
    ).rejects.toThrow("VITE0033");
  });
});

test.each<{
  name: string;
  rules: NonNullable<ViteDoctorSurfaceOptions["config"]>;
  skipped: boolean;
}>([
  { name: "globally disabled", rules: { rules: { [rule]: "off" } }, skipped: false },
  { name: "no presets selected", rules: { extends: [] }, skipped: false },
  {
    name: "disabled for the candidate",
    rules: { overrides: [{ files: ["src/main.ts"], rules: { [rule]: "off" } }] },
    skipped: false,
  },
  {
    name: "re-enabled only for an unrelated file",
    rules: {
      rules: { [rule]: "off" },
      overrides: [{ files: ["src/other.ts"], rules: { [rule]: "warn" } }],
    },
    skipped: false,
  },
  {
    name: "re-enabled for the candidate",
    rules: {
      rules: { [rule]: "off" },
      overrides: [{ files: ["src/main.ts"], rules: { [rule]: "error" } }],
    },
    skipped: true,
  },
])("checks missing maps with VITE0033 $name", async ({ rules, skipped }) => {
  await withProject(
    { "src/main.ts": `import "./other";\n${liveFs}`, "src/other.ts": 'console.log("other");' },
    async (root) => {
      const { logger, warnings } = capture();
      await build(
        config(root, logger, {
          plugins: [
            doctor({ rules: rule, cache: false, config: rules }),
            {
              name: "host-asset-names",
              outputOptions: {
                order: "post",
                handler: (output) => ({ ...output, assetFileNames: "assets/[name][extname]" }),
              },
            },
          ],
        }),
      );
      expect(warnings.some((message) => message.includes("VITE0033 verification skipped"))).toBe(
        skipped,
      );
    },
  );
});

test("warns about missing maps when a changed client import reaches an unchanged reader", async () => {
  await withProject(
    {
      "src/main.ts": 'console.log("client");\n',
      "src/db.ts": db,
      "src/unrelated.ts": 'console.log("unrelated");\n',
    },
    async (root) => {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
      git("init", "-q");
      git("add", "-A");
      git(
        "-c",
        "user.name=Doctor",
        "-c",
        "user.email=doctor@example.test",
        "commit",
        "-qm",
        "base",
      );
      const entry = join(root, "src/main.ts");
      await writeFile(entry, 'import { loadUsers } from "./db";\nconsole.log(loadUsers());\n');
      const { logger, warnings } = capture();
      const options = (disabled = false) =>
        config(root, logger, {
          plugins: [
            doctor({
              rules: rule,
              cache: false,
              changed: true,
              config: {
                rules: { [rule]: "error" },
                ...(disabled && {
                  overrides: [{ files: ["src/db.ts"], rules: { [rule]: "off" } }],
                }),
              },
            }),
            {
              name: "host-asset-names",
              outputOptions: {
                order: "post",
                handler: (output) => ({ ...output, assetFileNames: "assets/[name][extname]" }),
              },
            },
          ],
        });

      await expect(
        build({ ...options(), build: { write: false, sourcemap: "hidden" } }),
      ).rejects.toThrow(/VITE0033[\s\S]*through index\.html → src\/main\.ts → src\/db\.ts/);
      await build(options());
      expect(warnings.join("\n")).toContain("VITE0033 verification skipped");

      warnings.length = 0;
      await build(options(true));
      expect(warnings.join("\n")).not.toContain("VITE0033 verification skipped");

      git("add", "src/main.ts");
      git(
        "-c",
        "user.name=Doctor",
        "-c",
        "user.email=doctor@example.test",
        "commit",
        "-qm",
        "entry",
      );
      await writeFile(join(root, "src/unrelated.ts"), 'console.log("changed");\n');
      warnings.length = 0;
      await build(options());
      expect(warnings.join("\n")).not.toContain("VITE0033 verification skipped");
    },
  );
});

test("preserves host hidden maps requested by a later output hook", async () => {
  await withProject({ "src/main.ts": liveFs }, async (root) => {
    const { logger, warnings } = capture();
    const options = config(root, logger);
    const result = await build({
      ...options,
      plugins: [
        options.plugins,
        {
          name: "host-sourcemaps",
          outputOptions: {
            order: "post",
            handler: (output) => ({ ...output, sourcemap: "hidden" }),
          },
        },
      ],
    });
    expect(warnings.join("\n")).toContain("VITE0033");
    expect("output" in result && result.output.some((item) => item.fileName.endsWith(".map"))).toBe(
      true,
    );
  });
});

async function withWatch(
  root: string,
  options: InlineConfig,
  run: (nextPass: () => Promise<string>) => Promise<void>,
) {
  const watcher = await build(options);
  if (!("on" in watcher)) throw new Error("Expected a Vite build watcher");
  let { promise, resolve } = Promise.withResolvers<string>();
  let error = "";
  watcher.on("event", (event) => {
    if (event.code === "ERROR") error = event.error.message;
    if (event.code === "END") resolve(error);
  });
  try {
    await run(async () => {
      const result = await promise;
      ({ promise, resolve } = Promise.withResolvers<string>());
      error = "";
      return result;
    });
  } finally {
    await watcher.close();
    await rm(join(root, "dist"), { recursive: true, force: true });
  }
}

test("does not publish internal source maps on any watch write", async () => {
  await withProject({ "src/main.ts": 'console.log("first");' }, async (root) => {
    const { logger } = capture();
    const options = config(root, logger, { build: { watch: {}, write: true, sourcemap: false } });
    await withWatch(root, options, async (nextPass) => {
      const files = () => readdir(join(root, "dist", "assets"));
      expect(await nextPass()).toBe("");
      expect((await files()).filter((file) => file.endsWith(".map"))).toEqual([]);
      await writeFile(join(root, "src/main.ts"), 'console.log("second");');
      expect(await nextPass()).toBe("");
      expect((await files()).filter((file) => file.endsWith(".map"))).toEqual([]);
    });
  });
});

test("recovers from a VITE0033 error in watch mode and reports fresh findings", async () => {
  await withProject({ "src/main.ts": liveFs }, async (root) => {
    const { logger } = capture();
    const options = config(root, logger, {
      plugins: [doctor({ rules: rule, cache: false, config: { rules: { [rule]: "error" } } })],
      build: { watch: {}, write: true, sourcemap: "hidden" },
    });
    await withWatch(root, options, async (nextPass) => {
      expect(await nextPass()).toContain("VITE0033");
      await writeFile(join(root, "src/main.ts"), 'console.log("fixed");');
      expect(await nextPass()).toBe("");
      await writeFile(join(root, "src/main.ts"), 'console.log(import("node:crypto"));');
      expect(await nextPass()).toMatch(/VITE0033[^\n]*node:crypto/);
    });
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
