import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, type InlineConfig } from "vite";
import { expect, test } from "vite-plus/test";
import { doctor } from "../../src/plugin.ts";
import { runViteDoctor } from "../../src/doctor.ts";

const rule = "vite/env/no-client-secret-pattern";

async function withProject(name: string, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "doctor-env-exposure-"));
  try {
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(join(root, "entry.ts"), `export const exposed = import.meta.env.${name};\n`);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function hostBuild(root: string, options: InlineConfig = {}, ssr = false) {
  return build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [doctor({ rules: rule, cache: false })],
    ...options,
    build: ssr
      ? { write: false, ssr: join(root, "entry.ts") }
      : { write: false, lib: { entry: join(root, "entry.ts"), formats: ["es"] } },
  });
}

test.each([
  [undefined, "DB_PASSWORD", false],
  [undefined, "VITE_API_SECRET", true],
  ["PUBLIC_", "PRIVATE_API_SECRET", false],
  ["PUBLIC_", "VITE_API_SECRET", false],
  ["PUBLIC_", "PUBLIC_API_SECRET", true],
  [["PUBLIC_", "APP_"], "PRIVATE_API_SECRET", false],
  [["PUBLIC_", "APP_"], "APP_API_SECRET", true],
  [["PUBLIC_", "APP_"], "PUBLIC_API_SECRET", true],
  [[], "VITE_API_SECRET", false],
] satisfies Array<[string | string[] | undefined, string, boolean]>)(
  "uses resolved prefix %j for %s with exposure %s",
  async (envPrefix, name, exposed) => {
    await withProject(name, async (root) => {
      const result = hostBuild(root, { envPrefix });
      if (exposed) await expect(result).rejects.toThrow(rule);
      else await expect(result).resolves.toBeDefined();
    });
  },
);

test.each(["PRIVATE_API_SECRET", "PUBLIC_API_SECRET"])(
  "keeps public exposure evidence during SSR for %s",
  async (name) => {
    await withProject(name, async (root) => {
      const result = hostBuild(root, { envPrefix: "PUBLIC_" }, true);
      if (name.startsWith("PUBLIC_")) await expect(result).rejects.toThrow(rule);
      else await expect(result).resolves.toBeDefined();
    });
  },
);

test.each([
  { "import.meta.env.PRIVATE_API_SECRET": '"fixture-value"' },
  { "import.meta.env": { PRIVATE_API_SECRET: "fixture-value" } },
  { "import.meta": { env: { PRIVATE_API_SECRET: "fixture-value" } } },
])("retains explicit or whole-object define exposure: %j", async (define) => {
  await withProject("PRIVATE_API_SECRET", async (root) => {
    await expect(hostBuild(root, { envPrefix: "PUBLIC_", define })).rejects.toThrow(rule);
  });
});

test("retains environment-specific define exposure", async () => {
  await withProject("PRIVATE_API_SECRET", async (root) => {
    await expect(
      hostBuild(root, {
        envPrefix: "PUBLIC_",
        environments: {
          client: { define: { "import.meta.env.PRIVATE_API_SECRET": '"fixture-value"' } },
        },
      }),
    ).rejects.toThrow(rule);
  });
});

test("does not treat server-only environment defines as client exposure", async () => {
  await withProject("PRIVATE_API_SECRET", async (root) => {
    await expect(
      hostBuild(root, {
        envPrefix: "PUBLIC_",
        environments: {
          server: { define: { "import.meta.env.PRIVATE_API_SECRET": '"fixture-value"' } },
        },
      }),
    ).resolves.toBeDefined();
  });
});

test.each([
  ["browser", "client", true],
  ["client", "server", false],
] as const)("uses the resolved consumer for %s (%s)", async (environment, consumer, exposed) => {
  await withProject("PRIVATE_API_SECRET", async (root) => {
    const result = hostBuild(root, {
      envPrefix: "PUBLIC_",
      environments: {
        ssr: {},
        [environment]: {
          consumer,
          define: { "import.meta.env.PRIVATE_API_SECRET": '"fixture-value"' },
        },
      },
    });
    if (exposed) await expect(result).rejects.toThrow(rule);
    else await expect(result).resolves.toBeDefined();
  });
});

test("keeps unresolved environment consumers conservative", async () => {
  await withProject("PRIVATE_API_SECRET", async (root) => {
    let clearConsumer: () => void;
    await expect(
      hostBuild(root, {
        envPrefix: "PUBLIC_",
        environments: { browser: { consumer: "client" } },
        plugins: [
          {
            name: "fixture/unresolved-consumer",
            configResolved(config) {
              clearConsumer = () => {
                Object.assign(config.environments.browser, { consumer: undefined });
              };
            },
            buildStart() {
              clearConsumer();
            },
          },
          doctor({ rules: rule, cache: false }),
        ],
      }),
    ).rejects.toThrow(rule);
  });
});

test("lets Vite reject an empty public prefix before the Doctor Run", async () => {
  await withProject("PRIVATE_API_SECRET", async (root) => {
    await expect(hostBuild(root, { envPrefix: "" })).rejects.toThrow(/envPrefix/);
  });
});

test("keeps runs without host evidence conservative", async () => {
  await withProject("PRIVATE_API_SECRET", async (root) => {
    const result = await runViteDoctor({ root, rules: rule, cache: false });
    expect(result.diagnostics.map(({ code }) => code)).toEqual(["VITE0009"]);
  });
});

test.each([
  null,
  [],
  {},
  { root: undefined, prefixes: ["PUBLIC_"], defineKeys: [], hasObjectDefine: false },
  { root: "/other", prefixes: ["PUBLIC_"], defineKeys: [], hasObjectDefine: false },
  { prefixes: "PUBLIC_", defineKeys: [], hasObjectDefine: false },
  { prefixes: ["PUBLIC_", null], defineKeys: [], hasObjectDefine: false },
  { prefixes: Object.assign([], { length: 1 }), defineKeys: [], hasObjectDefine: false },
  { prefixes: ["PUBLIC_"], defineKeys: "PRIVATE_API_SECRET", hasObjectDefine: false },
  { prefixes: ["PUBLIC_"], defineKeys: [null], hasObjectDefine: false },
  { prefixes: ["PUBLIC_"], defineKeys: Object.assign([], { length: 1 }), hasObjectDefine: false },
  { prefixes: ["PUBLIC_"], defineKeys: [], hasObjectDefine: "false" },
])("does not use malformed or unrelated exposure evidence: %j", async (envExposure) => {
  await withProject("PRIVATE_API_SECRET", async (root) => {
    const result = await runViteDoctor({
      root,
      rules: rule,
      cache: false,
      extensions: [
        {
          name: "fixture/exposure",
          setup(api) {
            api.registerRuntimeEvidenceContributor({
              name: "vite",
              contribute: () => ({
                envExposure:
                  envExposure && typeof envExposure === "object" && !Array.isArray(envExposure)
                    ? { root, ...envExposure }
                    : envExposure,
              }),
            });
          },
        },
      ],
    });
    expect(result.diagnostics.map(({ code }) => code)).toEqual(["VITE0009"]);
  });
});

test("records prefix and define names without resolved values", async () => {
  await withProject("VITE_API_SECRET", async (root) => {
    let evidence: unknown;
    await writeFile(join(root, ".env"), "VITE_API_SECRET=private-env-marker\n");
    const surface = doctor({
      rules: rule,
      mode: "warn",
      cache: false,
      extensions: [
        {
          name: "fixture/observe",
          setup(api) {
            api.registerRuntimeEvidenceContributor({
              name: "fixture",
              contribute(project) {
                evidence = project.runtimeEvidence?.vite;
                return {};
              },
            });
          },
        },
      ],
    });
    await hostBuild(root, {
      define: { "import.meta.env.OTHER_SECRET": '"private-define-marker"' },
      plugins: [surface],
    });
    expect(evidence).toMatchObject({
      envExposure: {
        root,
        prefixes: ["VITE_"],
        defineKeys: ["OTHER_SECRET"],
        hasObjectDefine: false,
      },
    });
    expect(JSON.stringify(evidence)).not.toContain("private-env-marker");
    expect(JSON.stringify(evidence)).not.toContain("private-define-marker");
  });
});

test("keeps executable Doctor config disabled in the host", async () => {
  await withProject("PRIVATE_API_SECRET", async (root) => {
    await writeFile(join(root, "doctor.config.mjs"), 'throw new Error("must-not-execute");');
    await expect(hostBuild(root, { envPrefix: "PUBLIC_" })).resolves.toBeDefined();
  });
});
