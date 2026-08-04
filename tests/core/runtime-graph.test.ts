import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vite-plus/test";
import { createRule, detectProject, evaluateRuleApplicability } from "../../src/core/index.ts";
import { runViteDoctor } from "../../src/doctor.ts";

test("resolves the Nuxt to Nitro to H3 graph from each owning package", async () => {
  await withRuntimeGraph(
    {
      ...nuxtGraph({
        nuxt: "4.4.6",
        nitroName: "nitropack",
        nitro: "2.13.4",
        h3: "1.15.11",
      }),
      "node_modules/nitro/package.json": packageManifest("nitro", "3.0.0-beta.4", {
        h3: "2.0.0-rc.26",
      }),
    },
    async (root) => {
      const project = await detectProject(root);

      expect(project.runtimeGraph?.packages.nuxt?.version).toBe("4.4.6");
      expect(project.runtimeGraph?.packages.nitro).toMatchObject({
        name: "nitropack",
        version: "2.13.4",
        owner: "nuxt",
        state: "resolved",
      });
      expect(project.runtimeGraph?.packages.h3).toMatchObject({
        version: "1.15.11",
        owner: "nitro",
      });
      expect(project.nuxtCompatibility).toMatchObject({
        state: "resolved",
        version: 4,
        provenance: "default",
      });
    },
  );
});

test("keeps Nuxt compatibility 5 independent from Nitro and H3 generations", async () => {
  await withRuntimeGraph(
    {
      ...nuxtGraph({
        nuxt: "4.4.6",
        nitroName: "nitropack",
        nitro: "2.13.4",
        h3: "1.15.11",
      }),
      "nuxt.config.ts":
        "export default defineNuxtConfig({ future: { compatibilityVersion: 5 } })\n",
    },
    async (root) => {
      const project = await detectProject(root);

      expect(project.nuxtCompatibility?.version).toBe(5);
      expect(project.runtimeGraph?.packages.nitro?.version).toBe("2.13.4");
      expect(project.runtimeGraph?.packages.h3?.version).toBe("1.15.11");
    },
  );
});

test("ignores a stale compatibility manifest when Nuxt config is newer", async () => {
  await withRuntimeGraph(
    {
      ...nuxtGraph({
        nuxt: "4.4.6",
        nitroName: "nitropack",
        nitro: "2.13.4",
        h3: "1.15.11",
      }),
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: "2000-01-01T00:00:00.000Z",
        compatibilityVersion: 4,
      }),
      "nuxt.config.ts":
        "export default defineNuxtConfig({ future: { compatibilityVersion: 5 } })\n",
    },
    async (root) => {
      expect((await detectProject(root)).nuxtCompatibility).toMatchObject({
        state: "resolved",
        version: 5,
        provenance: "config",
      });
    },
  );
});

test("ignores an unsupported compatibility version from the generated manifest", async () => {
  await withRuntimeGraph(
    {
      ...nuxtGraph({
        nuxt: "4.4.6",
        nitroName: "nitropack",
        nitro: "2.13.4",
        h3: "1.15.11",
      }),
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: "2999-01-01T00:00:00.000Z",
        compatibilityVersion: 6,
      }),
      "nuxt.config.ts":
        "export default defineNuxtConfig({ future: { compatibilityVersion: 5 } })\n",
    },
    async (root) => {
      expect((await detectProject(root)).nuxtCompatibility).toMatchObject({
        state: "resolved",
        version: 5,
        provenance: "config",
      });
    },
  );
});

test("ignores compatibilityVersion keys outside exported future config", async () => {
  await withRuntimeGraph(
    {
      ...nuxtGraph({
        nuxt: "4.4.6",
        nitroName: "nitropack",
        nitro: "2.13.4",
        h3: "1.15.11",
      }),
      "nuxt.config.ts": `const moduleOptions = { compatibilityVersion: 5 }
export default defineNuxtConfig({ modules: [["example", moduleOptions]] })
`,
    },
    async (root) => {
      expect((await detectProject(root)).nuxtCompatibility).toMatchObject({
        state: "resolved",
        version: 4,
        provenance: "default",
      });
    },
  );
});

test("treats indirect exported Nuxt config compatibility as unknown", async () => {
  await withRuntimeGraph(
    {
      ...nuxtGraph({
        nuxt: "4.4.6",
        nitroName: "nitropack",
        nitro: "2.13.4",
        h3: "1.15.11",
      }),
      "nuxt.config.ts": `const config = { future: { compatibilityVersion: 5 } }
export default defineNuxtConfig(config)
`,
    },
    async (root) => {
      const result = await runViteDoctor({ root, cache: false });

      expect(result.project.nuxtCompatibility?.state).toBe("unknown");
      expect(result.diagnostics.filter((item) => item.code === "DOC0022")).toHaveLength(1);
    },
  );
});

test("does not report ignored root config inside module options", async () => {
  await withRuntimeGraph(
    {
      ...nuxtGraph({
        nuxt: "4.4.6",
        nitroName: "nitropack",
        nitro: "2.13.4",
        h3: "1.15.11",
      }),
      "nuxt.config.ts": `export default defineNuxtConfig({
  modules: [["example", { experimental: { parseErrorData: false } }]],
})
`,
    },
    async (root) => {
      const result = await runViteDoctor({
        root,
        runtimeTarget: { nuxtCompatibility: 5 },
        rules: "nuxt/config/no-ignored-compatibility-config",
        cache: false,
      });

      expect(result.diagnostics.some((item) => item.code === "NUXT0073")).toBe(false);
    },
  );
});

test("matches compound ranges and prereleases deliberately", async () => {
  await withRuntimeGraph(
    nuxtGraph({
      nuxt: "5.0.0-0",
      nitroName: "nitro",
      nitro: "3.0.260610-beta",
      h3: "2.0.1-rc.26",
    }),
    async (root) => {
      const project = await detectProject(root);
      const prereleaseRule = createRule({
        meta: {
          id: "fixture/prerelease",
          title: "Prerelease",
          category: "test",
          severity: "warn",
          applicability: {
            runtimes: { nitro: ">=3.0.0-0 <4", h3: ">=2.0.0-0 <3" },
            includePrerelease: true,
          },
        },
        create() {},
      });

      expect(evaluateRuleApplicability(prereleaseRule, project).state).toBe("active");
      expect(project.nuxtCompatibility?.version).toBe(5);
    },
  );
});

test("standalone Nitro resolves its owned H3 instead of a root duplicate", async () => {
  await withRuntimeGraph(
    {
      "package.json": JSON.stringify({ dependencies: { nitro: "3.0.260610-beta", h3: "1.15.11" } }),
      "node_modules/nitro/package.json": packageManifest("nitro", "3.0.260610-beta", {
        h3: "2.0.1-rc.26",
      }),
      "node_modules/nitro/node_modules/h3/package.json": packageManifest("h3", "2.0.1-rc.26"),
      "node_modules/h3/package.json": packageManifest("h3", "1.15.11"),
    },
    async (root) => {
      const project = await detectProject(root);

      expect(project.framework).toBe("nitro");
      expect(project.runtimeGraph?.packages.h3?.version).toBe("2.0.1-rc.26");
      expect(project.runtimeGraph?.packages.h3?.packageJsonPath).toContain(
        "node_modules/nitro/node_modules/h3/package.json",
      );
    },
  );
});

test("unknown package identity suppresses version rules and emits one inventory diagnostic", async () => {
  await withRuntimeGraph(
    {
      "package.json": JSON.stringify({ dependencies: { nitro: "npm:custom-nitro@3.0.0" } }),
      "node_modules/nitro/package.json": packageManifest("custom-nitro", "3.0.0"),
      "server/api/index.ts": 'import { defineConfig } from "nitropack"\n',
    },
    async (root) => {
      const result = await runViteDoctor({
        root,
        rules: "nitro/migration/no-v2-imports",
        cache: false,
      });

      expect(result.diagnostics.filter((item) => item.code === "DOC0022")).toHaveLength(1);
      expect(
        result.diagnostics.some((item) => item.ruleId === "nitro/migration/no-v2-imports"),
      ).toBe(false);
      expect(result.project.runtimeGraph?.packages.nitro?.identity).toBe("unknown");
    },
  );
});

async function withRuntimeGraph(
  files: Record<string, string>,
  run: (root: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "vite-doctor-runtime-"));
  try {
    for (const [file, contents] of Object.entries(files)) {
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
    }
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function nuxtGraph(options: {
  nuxt: string;
  nitroName: "nitro" | "nitropack";
  nitro: string;
  h3: string;
}) {
  return {
    "package.json": JSON.stringify({ dependencies: { nuxt: options.nuxt, vue: "3.5.35" } }),
    "node_modules/nuxt/package.json": packageManifest("nuxt", options.nuxt, {
      [options.nitroName]: options.nitro,
    }),
    [`node_modules/nuxt/node_modules/${options.nitroName}/package.json`]: packageManifest(
      options.nitroName,
      options.nitro,
      { h3: options.h3 },
    ),
    [`node_modules/nuxt/node_modules/${options.nitroName}/node_modules/h3/package.json`]:
      packageManifest("h3", options.h3),
    "node_modules/vue/package.json": packageManifest("vue", "3.5.35"),
  };
}

function packageManifest(name: string, version: string, dependencies?: Record<string, string>) {
  return JSON.stringify({ name, version, dependencies });
}
