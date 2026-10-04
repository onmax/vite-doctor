import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, createBuilder } from "vite";
import { expect, test } from "vite-plus/test";
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
