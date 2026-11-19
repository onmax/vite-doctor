import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { build, createLogger, createServer } from "vite";
import { expect, test, vi } from "vite-plus/test";
import {
  allDiagnostics,
  createRule,
  defineDoctorExtension,
  defineRulePack,
} from "../../src/core/index.ts";
import { main } from "../../src/cli.ts";
import { runViteDoctor } from "../../src/doctor.ts";
import { doctor } from "../../src/plugin.ts";

/** Reports every line that contains TODO. */
const todoLines = createRule({
  meta: {
    id: "fixture/todo-line",
    title: "TODO line",
    category: "fixture",
    severity: "warn",
    reportScope: "project",
  },
  create(ctx) {
    for (const match of ctx.file.text.matchAll(/TODO/g))
      ctx.report(
        allDiagnostics.DOC9999({
          why: `A TODO is left in ${ctx.file.relativePath}.`,
          fix: "Finish it.",
        }),
        {
          range: ctx.range(match.index, match.index + 4),
          related:
            ctx.file.relativePath === "primary.ts"
              ? [
                  {
                    file: join(ctx.project.root, "entry.ts"),
                    range: { start: 0, end: 1, line: 1, column: 1 },
                    message: "Related unchanged line.",
                  },
                ]
              : undefined,
        },
      );
  },
});

const extension = defineDoctorExtension({
  name: "fixture/plugin-since",
  rulePacks: [
    defineRulePack({
      name: "fixture/plugin-since",
      version: "0.0.0",
      rules: [todoLines],
      presets: { recommended: [todoLines.meta.id] },
    }),
  ],
});

function git(root: string, ...args: string[]) {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

async function withRepository(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "doctor-plugin-since-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(root, "entry.ts"), 'export const old = "TODO";\n');
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(
      root,
      "-c",
      "user.name=Doctor",
      "-c",
      "user.email=doctor@example.test",
      "commit",
      "-qm",
      "base",
    );
    git(root, "checkout", "-q", "-b", "feature");
    await writeFile(
      join(root, "entry.ts"),
      'export const old = "TODO";\nexport const added = "TODO";\n',
    );
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function buildReport(root: string, options: Parameters<typeof doctor>[0] = {}) {
  const logged: string[] = [];
  const logger = createLogger("silent");
  logger.warn = (message) => void logged.push(message);
  logger.info = (message) => void logged.push(message);
  await build({
    root,
    configFile: false,
    customLogger: logger,
    plugins: [
      doctor({
        mode: "warn",
        format: "json",
        cache: false,
        extends: ["fixture/plugin-since/recommended"],
        extensions: [extension],
        ...options,
      }),
    ],
    build: { write: false, lib: { entry: join(root, "entry.ts"), formats: ["es"] } },
  });
  const report = logged.find((message) => message.trimStart().startsWith("{"));
  if (!report) throw new Error(`No Doctor report was logged: ${logged.join("\n")}`);
  return JSON.parse(report) as {
    diagnostics: Array<{ code: string; location: { path: string; line: number } }>;
  };
}

async function cliLines(root: string, options: { since?: string; changed?: boolean }) {
  const result = await runViteDoctor({
    root,
    ...options,
    cache: false,
    extends: ["fixture/plugin-since/recommended"],
    extensions: [extension],
  });
  return result.diagnostics.map((item) => item.range?.line);
}

test("the Vite Plugin Surface's since limits Diagnostics to lines changed since the ref", async () => {
  await withRepository(async (root) => {
    const full = await buildReport(root, {});
    expect(full.diagnostics.map((item) => item.location.line)).toEqual([1, 2]);

    const since = await buildReport(root, { since: "main" });
    expect(since.diagnostics.map((item) => item.location.line)).toEqual([2]);
    expect(await cliLines(root, { since: "main" })).toEqual([2]);
  });
});

test("the Vite Plugin Surface's changed limits Diagnostics to uncommitted lines", async () => {
  await withRepository(async (root) => {
    const changed = await buildReport(root, { changed: true });
    expect(changed.diagnostics.map((item) => item.location.line)).toEqual([2]);
    expect(await cliLines(root, { changed: true })).toEqual([2]);
  });
});

test.each([{ changed: true }, { since: "main" }])(
  "Git-scoped serve saves retain Diagnostics on other changed files: %j",
  async (scope) => {
    await withRepository(async (root) => {
      const entry = join(root, "entry.ts");
      const primary = join(root, "primary.ts");
      await writeFile(entry, 'export const old = "TODO";\nexport const added = 1;\n');
      await writeFile(primary, 'export const primary = "TODO";\n');
      const messages: string[] = [];
      const logger = createLogger("silent");
      logger.warn = logger.info = (message) => void messages.push(message);
      const server = await createServer({
        root,
        configFile: false,
        customLogger: logger,
        plugins: [
          doctor({
            ...scope,
            run: "serve",
            mode: "warn",
            cache: false,
            extends: ["fixture/plugin-since/recommended"],
            extensions: [extension],
          }),
        ],
        server: { middlewareMode: true, ws: false, watch: null },
        optimizeDeps: { noDiscovery: true },
      });
      try {
        await vi.waitFor(() =>
          expect(messages.some((line) => line.includes("A TODO is left in primary.ts."))).toBe(
            true,
          ),
        );
        messages.length = 0;

        await writeFile(entry, 'export const old = "TODO";\nexport const added = "TODO";\n');
        server.watcher.emit("change", entry);
        await vi.waitFor(() =>
          expect(messages.join("\n")).toContain("A TODO is left in entry.ts."),
        );
        expect(messages.join("\n")).not.toContain("resolved:");

        await writeFile(primary, "export const primary = 1;\n");
        server.watcher.emit("change", primary);
        await vi.waitFor(() => expect(messages.join("\n")).toMatch(/resolved: .*primary\.ts/));
      } finally {
        await server.close();
      }
    });
  },
);

const manifest = (value: object) => `${JSON.stringify(value, null, 2)}\n`;

const auth = { name: "@x/auth", version: "1.0.0", peerDependencies: { "drizzle-orm": "^1.0.0" } };
const realtime = {
  name: "@x/realtime",
  version: "1.0.0",
  dependencies: { "@x/auth": "workspace:*", "old-ui": "1.0.0", vue: "^3.5.0" },
};
const email = { name: "@x/email", version: "1.0.0", dependencies: { vue: "^3.5.0" } };

const lockfile = (oldUiVue: string) =>
  [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .: {}",
    "",
    "  packages/auth: {}",
    "",
    "  packages/email:",
    "    dependencies:",
    "      vue:",
    "        specifier: ^3.5.0",
    "        version: 3.5.44",
    "",
    "  packages/realtime:",
    "    dependencies:",
    "      '@x/auth':",
    "        specifier: workspace:*",
    "        version: link:../auth",
    "      old-ui:",
    "        specifier: 1.0.0",
    "        version: 1.0.0",
    "      vue:",
    "        specifier: ^3.5.0",
    "        version: 3.5.44",
    "",
    "snapshots:",
    "",
    "  old-ui@1.0.0:",
    "    dependencies:",
    `      vue: ${oldUiVue}`,
    "",
    ...(oldUiVue === "3.5.44" ? [] : [`  vue@${oldUiVue}: {}`, ""]),
    "  vue@3.5.44: {}",
    "",
  ].join("\n");

/**
 * A pnpm workspace whose committed state already has one PKG0007, at the "@x/auth" entry of
 * packages/realtime/package.json (line 5).
 */
async function withWorkspace(
  change: (root: string) => Promise<void>,
  run: (root: string) => Promise<void>,
  baseAuth: object = auth,
  baseLockfile = lockfile("3.5.44"),
) {
  const root = await mkdtemp(join(tmpdir(), "doctor-since-workspace-"));
  const write = async (file: string, text: string) => {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), text);
  };
  try {
    await write("package.json", manifest({ private: true, type: "module" }));
    await write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    await write("pnpm-lock.yaml", baseLockfile);
    await write("packages/auth/package.json", manifest(baseAuth));
    await write("packages/realtime/package.json", manifest(realtime));
    await write("packages/realtime/entry.ts", "export const entry = 1;\n");
    await write("packages/email/package.json", manifest(email));
    await write("entry.ts", "export const entry = 1;\n");
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(
      root,
      "-c",
      "user.name=Doctor",
      "-c",
      "user.email=doctor@example.test",
      "commit",
      "-qm",
      "base",
    );
    git(root, "checkout", "-q", "-b", "feature");
    await change(root);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

type ReportedDiagnostic = {
  code: string;
  message: string;
  location: { path: string; line?: number };
};

const packageFindings = (diagnostics: ReportedDiagnostic[]) =>
  diagnostics
    .filter((item) => item.code.startsWith("PKG"))
    .map((item) => `${item.code} ${item.location.path}:${item.location.line}`)
    .sort();

/** The same `since` run through the CLI Surface and the Vite Plugin Surface. */
async function sinceFindings(root: string, since?: string) {
  const writes: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await main(
      [
        ".",
        "--extends",
        "vite-doctor/package/recommended",
        ...(since ? ["--since", since] : []),
        "--format",
        "json",
        "--no-cache",
        "--no-server",
      ],
      root,
    );
  } finally {
    process.stdout.write = write;
  }
  const cli = JSON.parse(writes.join("")) as { diagnostics: ReportedDiagnostic[] };
  const plugin = (await buildReport(root, {
    since,
    extends: ["vite-doctor/package/recommended"],
    extensions: undefined,
  })) as unknown as { diagnostics: ReportedDiagnostic[] };
  expect(packageFindings(plugin.diagnostics)).toEqual(packageFindings(cli.diagnostics));
  return { findings: packageFindings(cli.diagnostics), diagnostics: cli.diagnostics };
}

test("since reports a workspace finding on the changed package.json line", async () => {
  await withWorkspace(
    async (root) => {
      await writeFile(
        join(root, "packages/email/package.json"),
        manifest({ ...email, dependencies: { "@x/auth": "workspace:*", vue: "^3.5.0" } }),
      );
    },
    async (root) => {
      expect((await sinceFindings(root)).findings).toEqual([
        "PKG0007 packages/email/package.json:5",
        "PKG0007 packages/realtime/package.json:5",
      ]);
      expect((await sinceFindings(root, "main")).findings).toEqual([
        "PKG0007 packages/email/package.json:5",
      ]);
    },
  );
});

test("since reports a duplicate singleton that only the lockfile change introduces", async () => {
  await withWorkspace(
    async (root) => {
      await writeFile(join(root, "pnpm-lock.yaml"), lockfile("3.4.0"));
    },
    async (root) => {
      expect((await sinceFindings(root, "main")).findings).toEqual([
        "PKG0008 packages/realtime/package.json:6",
      ]);
      const nested = join(root, "packages/realtime");
      expect((await sinceFindings(nested)).findings).toContain("PKG0008 package.json:6");
      expect((await sinceFindings(nested, "main")).findings).toEqual(["PKG0008 package.json:6"]);
    },
  );
});

test("since reports a duplicate introduced by an intermediate lockfile resolution", async () => {
  const base = lockfile("3.5.44").replace(
    "  old-ui@1.0.0:\n    dependencies:\n      vue: 3.5.44",
    [
      "  old-ui@1.0.0:",
      "    dependencies:",
      "      bridge: 1.0.0",
      "  bridge@1.0.0:",
      "    dependencies:",
      "      vue: 3.5.44",
      "  bridge@2.0.0:",
      "    dependencies:",
      "      vue: 3.4.0",
      "  vue@3.4.0: {}",
    ].join("\n"),
  );
  await withWorkspace(
    (root) =>
      writeFile(join(root, "pnpm-lock.yaml"), base.replace("bridge: 1.0.0", "bridge: 2.0.0")),
    async (root) => {
      expect((await sinceFindings(root)).findings).toContain(
        "PKG0008 packages/realtime/package.json:6",
      );
      expect((await sinceFindings(root, "main")).findings).toEqual([
        "PKG0008 packages/realtime/package.json:6",
      ]);
    },
    auth,
    base,
  );
});

const authWithPeers = { ...auth, peerDependencies: { h3: "^1.0.0", ...auth.peerDependencies } };

test.each([false, true])(
  "since uses only changed peer lines after a manifest rename (edited: %s)",
  async (edited) => {
    await withWorkspace(
      async (root) => {
        await mkdir(join(root, "packages/moved-auth"));
        git(root, "mv", "packages/auth/package.json", "packages/moved-auth/package.json");
        if (edited) {
          git(root, "config", "diff.renames", "false");
          await writeFile(
            join(root, "packages/moved-auth/package.json"),
            manifest({
              ...authWithPeers,
              peerDependencies: { ...authWithPeers.peerDependencies, h3: "^2.0.0" },
            }),
          );
        }
      },
      async (root) => {
        for (const scope of [".", "packages/realtime"]) {
          const { diagnostics } = await sinceFindings(join(root, scope), "main");
          const peers = diagnostics.filter((item) => item.code === "PKG0007");
          expect(peers).toHaveLength(edited ? 1 : 0);
          if (edited) expect(peers[0]?.message).toContain('"h3"');
        }
      },
      authWithPeers,
    );
  },
);

test.each([
  [
    "optional peer metadata",
    { peerDependenciesMeta: { h3: { optional: true } } },
    { peerDependenciesMeta: { h3: { optional: false } } },
  ],
  ["default dependency", { dependencies: { h3: "^1.0.0" } }, { dependencies: { h3: "^2.0.0" } }],
])(
  "since reports a peer made required by changed %s in a sibling manifest",
  async (_, before, after) => {
    await withWorkspace(
      (root) =>
        writeFile(
          join(root, "packages/auth/package.json"),
          manifest({ ...authWithPeers, ...after }),
        ),
      async (root) => {
        const nested = join(root, "packages/realtime");
        expect((await sinceFindings(root, "main")).findings).toEqual([
          "PKG0007 packages/realtime/package.json:5",
        ]);
        const { findings, diagnostics } = await sinceFindings(nested, "main");
        expect(findings).toEqual(["PKG0007 package.json:5"]);
        expect(diagnostics.find((item) => item.code === "PKG0007")?.message).toContain('"h3"');
      },
      { ...authWithPeers, ...before },
    );
  },
);

test("since does not include an existing peer finding when another peer's metadata changes", async () => {
  const before = {
    ...authWithPeers,
    peerDependenciesMeta: { h3: { optional: false }, "drizzle-orm": { optional: false } },
  };
  await withWorkspace(
    (root) =>
      writeFile(
        join(root, "packages/auth/package.json"),
        manifest({
          ...before,
          peerDependenciesMeta: {
            ...before.peerDependenciesMeta,
            "drizzle-orm": { optional: true },
          },
        }),
      ),
    async (root) => {
      expect((await sinceFindings(root)).findings).toEqual([
        "PKG0007 packages/realtime/package.json:5",
      ]);
      expect((await sinceFindings(root, "main")).findings).toEqual([]);
    },
    before,
  );
});

test("since does not accept changed manifest evidence for a file-scoped Rule", async () => {
  const localRule = createRule({
    meta: { ...todoLines.meta, id: "fixture/local", reportScope: "file" },
    create(ctx) {
      if (ctx.file.relativePath !== "entry.ts") return;
      ctx.report(allDiagnostics.DOC9999({ why: "File-local finding.", fix: "Fix it." }), {
        range: ctx.range(0, 1),
        evidence: [
          {
            kind: "manifest",
            file: join(ctx.project.root, "package.json"),
            range: { start: 0, end: 1, line: 1, column: 1 },
            summary: "Manifest evidence.",
          },
        ],
      });
    },
  });
  const localExtension = defineDoctorExtension({
    name: "fixture/local",
    rulePacks: [
      defineRulePack({
        name: "fixture/local",
        version: "0.0.0",
        rules: [localRule],
        presets: { recommended: [localRule.meta.id] },
      }),
    ],
  });
  await withRepository(async (root) => {
    await writeFile(join(root, "package.json"), '{"type":"module","private":true}');
    const options = {
      root,
      cache: false,
      extends: ["fixture/local/recommended"],
      extensions: [localExtension],
    };
    expect(
      (await runViteDoctor(options)).diagnostics.some((item) => item.ruleId === localRule.meta.id),
    ).toBe(true);
    expect(
      (await runViteDoctor({ ...options, since: "main" })).diagnostics.some(
        (item) => item.ruleId === localRule.meta.id,
      ),
    ).toBe(false);
  });
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "changed ignores unreadable unrelated untracked files",
  async () => {
    await withRepository(async (root) => {
      const scratch = join(root, "scratch.txt");
      await writeFile(scratch, "unreadable\n");
      await chmod(scratch, 0o000);
      const report = await runViteDoctor({ root, changed: true, cache: false });
      expect(report.scope).toMatchObject({ mode: "changed", files: 1 });
    });
  },
);

test("since reports a missing peer forwarded from a changed workspace dependency", async () => {
  await withWorkspace(
    async (root) => {
      await writeFile(
        join(root, "packages/auth/package.json"),
        manifest({ ...auth, peerDependencies: { h3: "^1.15.0", ...auth.peerDependencies } }),
      );
    },
    async (root) => {
      const { findings, diagnostics } = await sinceFindings(root, "main");
      expect(findings).toEqual(["PKG0007 packages/realtime/package.json:5"]);
      expect(diagnostics.find((item) => item.code === "PKG0007")?.message).toContain('"h3"');
    },
  );
});

test("since stays quiet about workspace findings whose manifest entries did not change", async () => {
  await withWorkspace(
    async (root) => {
      await writeFile(
        join(root, "packages/realtime/package.json"),
        manifest({ ...realtime, version: "1.0.1" }),
      );
      await writeFile(join(root, "entry.ts"), "export const entry = 2;\n");
    },
    async (root) => {
      expect((await sinceFindings(root)).findings).toEqual([
        "PKG0007 packages/realtime/package.json:5",
      ]);
      expect((await sinceFindings(root, "main")).findings).toEqual([]);
    },
  );
});
