import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, createBuilder, type Logger } from "vite";
import { expect, test } from "vite-plus/test";
import { createRule, defineDoctorExtension, defineRulePack } from "../../src/extension.ts";
import { doctor } from "../../src/plugin.ts";

async function withProject(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "doctor-plugin-lifecycle-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(root, "entry.ts"), 'export const greeting = "hello";\n');
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a reused Plugin Surface diagnoses each resolved Vite build", async () => {
  await withProject(async (root) => {
    const plugin = doctor({ rules: "vite/env/no-client-secret-pattern", cache: false });
    const config = {
      root,
      configFile: false as const,
      logLevel: "silent" as const,
      plugins: [plugin],
      build: {
        write: false,
        lib: { entry: join(root, "entry.ts"), formats: ["es" as const] },
      },
    };
    await build(config);
    await writeFile(
      join(root, "entry.ts"),
      "export const secret = import.meta.env.VITE_API_SECRET;\n",
    );
    await expect(build(config)).rejects.toThrow("vite/env/no-client-secret-pattern");
  });
});

test("a shared Plugin Surface runs once across a Vite application's environments", async () => {
  await withProject(async (root) => {
    let runs = 0;
    const plugin = doctor({
      rules: "vite",
      cache: false,
      extensions: [
        {
          name: "fixture/count-runs",
          setup(api) {
            api.registerProjectInventoryContributor({
              name: "fixture",
              contribute() {
                runs++;
                return {};
              },
            });
          },
        },
      ],
    });
    const builder = await createBuilder({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [plugin],
      builder: { sharedPlugins: true },
      build: {
        write: false,
        lib: { entry: join(root, "entry.ts"), formats: ["es"] },
      },
      environments: { ssr: { consumer: "server" } },
    });
    await builder.buildApp();
    expect(Object.keys(builder.environments)).toEqual(["client", "ssr"]);
    expect(runs).toBe(1);
  });
});

test("fails a Vite build when the Doctor Run is incomplete", async () => {
  await withProject(async (root) => {
    const incompleteRule = createRule({
      meta: {
        id: "fixture/incomplete-evidence",
        title: "Incomplete evidence fixture",
        category: "inventory",
        severity: "info",
        execution: "workspace",
      },
      create() {
        return {
          onProjectStart(project) {
            project.evidenceGaps = [
              {
                source: "fixture",
                message: "Fixture evidence is missing.",
                files: ["fixture.manifest.json"],
              },
            ];
          },
        };
      },
    });
    const plugin = doctor({
      rules: incompleteRule.meta.id,
      cache: false,
      extensions: [
        defineDoctorExtension({
          name: "fixture/incomplete-evidence",
          rulePacks: [
            defineRulePack({
              name: "fixture",
              version: "0.0.0",
              rules: [incompleteRule],
              presets: { recommended: [incompleteRule.meta.id] },
            }),
          ],
        }),
      ],
    });

    await expect(
      build({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [plugin],
        build: {
          write: false,
          lib: { entry: join(root, "entry.ts"), formats: ["es"] },
        },
      }),
    ).rejects.toThrow(/Fixture evidence is missing/);
  });
});

test("fails a Vite build when the Vue runtime cannot be resolved", async () => {
  await withProject(async (root) => {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ type: "module", dependencies: { vue: "^3.5.0" } }),
    );
    await mkdir(join(root, "node_modules/vue"), { recursive: true });
    await writeFile(
      join(root, "node_modules/vue/package.json"),
      JSON.stringify({ name: "custom-vue", version: "5.0.0" }),
    );
    const plugin = doctor({ framework: "vue", cache: false });

    await expect(
      build({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [plugin],
        build: {
          write: false,
          lib: { entry: join(root, "entry.ts"), formats: ["es"] },
        },
      }),
    ).rejects.toThrow(/DOC0022|unresolved runtime/i);
  });
});

test("warn mode keeps an incomplete Vite build running", async () => {
  await withProject(async (root) => {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ type: "module", dependencies: { vue: "^3.5.0" } }),
    );
    await mkdir(join(root, "node_modules/vue"), { recursive: true });
    await writeFile(
      join(root, "node_modules/vue/package.json"),
      JSON.stringify({ name: "custom-vue", version: "5.0.0" }),
    );
    const plugin = doctor({ framework: "vue", mode: "warn", cache: false });
    const warnings: string[] = [];
    const customLogger: Logger = {
      info() {},
      warn(message) {
        warnings.push(message);
      },
      warnOnce(message) {
        warnings.push(message);
      },
      error() {},
      clearScreen() {},
      hasErrorLogged() {
        return false;
      },
      hasWarned: false,
    };

    await expect(
      build({
        root,
        configFile: false,
        logLevel: "warn",
        customLogger,
        plugins: [plugin],
        build: {
          write: false,
          lib: { entry: join(root, "entry.ts"), formats: ["es"] },
        },
      }),
    ).resolves.toBeDefined();
    expect(warnings.join("\n")).toMatch(/DOC0022|incomplete|unresolved runtime/i);
  });
});
