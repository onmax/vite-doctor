import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, createBuilder, type InlineConfig, type Logger } from "vite";
import { expect, test } from "vite-plus/test";
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
    for (const [file, content] of Object.entries(files)) await writeFile(join(root, file), content);
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
          browserStubReads: ["src/db.ts"],
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
