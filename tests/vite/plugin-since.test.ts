import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { build, createLogger, createServer } from "vite";
import { expect, test, vi } from "vite-plus/test";
import {
  allDiagnostics,
  createRule,
  defineDoctorExtension,
  defineRulePack,
} from "../../src/core/index.ts";
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

async function buildReport(root: string, options: Parameters<typeof doctor>[0]) {
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
        ...options,
        mode: "warn",
        format: "json",
        cache: false,
        extends: ["fixture/plugin-since/recommended"],
        extensions: [extension],
      }),
    ],
    build: { write: false, lib: { entry: join(root, "entry.ts"), formats: ["es"] } },
  });
  const report = logged.find((message) => message.trimStart().startsWith("{"));
  if (!report) throw new Error(`No Doctor report was logged: ${logged.join("\n")}`);
  return JSON.parse(report) as { diagnostics: Array<{ location: { line: number } }> };
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
