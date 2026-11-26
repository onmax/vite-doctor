import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildNuxt, loadNuxt } from "nuxt/kit";
import { dirname, join } from "pathe";
import { afterEach, expect, test } from "vite-plus/test";
import { createAgentReport, createJsonReport, detectProject } from "../../src/core/index.ts";
import { hostDoctorExtensions, runViteDoctor, viteDoctorExtensions } from "../../src/doctor.ts";
import { workspaceProjectView } from "../../src/core/internal/workspace-nuxt.ts";
import nuxtDoctorModule from "../../src/rule-packs/nuxt/module.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "doctor-workspace-activation-"));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const button = "<template><button>Save</button></template>\n";

function nitroRootMonorepo(members: Record<string, string> = {}) {
  return fixture({
    "package.json": JSON.stringify({
      name: "workspace",
      private: true,
      devDependencies: { nitro: "^3.0.0" },
    }),
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    "packages/app/package.json": JSON.stringify({
      name: "@workspace/app",
      dependencies: { vue: "^3.5.0" },
    }),
    "packages/app/src/Save.vue": button,
    "packages/lib/package.json": JSON.stringify({ name: "@workspace/lib" }),
    "packages/lib/src/Save.vue": button,
    ...members,
  });
}

const buttonRule = "vue/template/html-button-has-type";

test("a workspace package activates the Vue Rule Pack when the root only depends on Nitro", async () => {
  const root = nitroRootMonorepo();
  expect((await viteDoctorExtensions({ root })).map((extension) => extension.name)).toEqual(
    expect.arrayContaining(["vite-doctor/builtin-nitro", "vite-doctor/builtin-vue"]),
  );

  const result = await runViteDoctor({ root, cache: false });

  expect(result.framework).toBe("nitro");
  expect(
    result.diagnostics
      .filter((diagnostic) => diagnostic.ruleId === buttonRule)
      .map((diagnostic) => diagnostic.file.slice(root.length + 1)),
  ).toEqual(["packages/app/src/Save.vue"]);
  expect(
    result.workspacePackages?.map(({ root, framework, rulePacks }) => ({
      root,
      framework,
      vue: rulePacks.includes("vite-doctor/vue"),
      nitro: rulePacks.includes("vite-doctor/nitro"),
    })),
  ).toEqual([
    { root: ".", framework: "nitro", vue: false, nitro: true },
    { root: "packages/app", framework: "vue", vue: true, nitro: false },
    { root: "packages/lib", framework: "vite", vue: false, nitro: false },
  ]);
  expect(JSON.parse(createJsonReport(result)).workspacePackages[1]).toMatchObject({
    root: "packages/app",
    name: "@workspace/app",
    framework: "vue",
    rulePacks: expect.arrayContaining(["vite-doctor/vue"]),
  });
});

test("extends strict scopes each strict preset to the workspace packages that activate it", async () => {
  const shorthand = '<template><button type="button" :disabled="true">Save</button></template>\n';
  const root = nitroRootMonorepo({
    "packages/app/src/Save.vue": shorthand,
    "packages/lib/src/Save.vue": shorthand,
  });
  const strictRule = "vue/template/prefer-true-attribute-shorthand";
  const filesFor = (result: Awaited<ReturnType<typeof runViteDoctor>>) =>
    result.diagnostics
      .filter((diagnostic) => diagnostic.ruleId === strictRule)
      .map((diagnostic) => diagnostic.file.slice(root.length + 1));

  expect(filesFor(await runViteDoctor({ root, cache: false, severity: "info" }))).toEqual([]);
  expect(
    filesFor(await runViteDoctor({ root, cache: false, severity: "info", extends: "strict" })),
  ).toEqual(["packages/app/src/Save.vue"]);
});

test("agent commands rerun workspace Doctor Runs with automatic framework selection", async () => {
  const root = nitroRootMonorepo();
  const result = await runViteDoctor({ root, cache: false });
  const report = JSON.parse(createAgentReport(result, { runOptions: { root } }));

  expect(report.commandArgs.rerun.slice(0, 4)).toEqual(["vite-doctor", ".", "--framework", "auto"]);
  expect(report.commandArgs.explain).toContain("auto");
  expect(report.project.workspacePackages).toEqual(result.workspacePackages);
  expect(
    JSON.parse(createAgentReport(result, { runOptions: { root, framework: "nitro" } })).commandArgs
      .rerun[3],
  ).toBe("nitro");
});

test("a Nuxt workspace package selects the Nuxt run and scopes Nuxt Rule Packs to it", async () => {
  const root = nitroRootMonorepo({
    "packages/site/package.json": JSON.stringify({
      name: "@workspace/site",
      dependencies: { nuxt: "^4.0.0" },
    }),
    "packages/site/nuxt.config.ts": "export default defineNuxtConfig({})\n",
  });

  const result = await runViteDoctor({ root, cache: false });

  expect(result.framework).toBe("nitro");
  expect(result.project.framework).toBe("nuxt");
  const activations = new Map(
    result.workspacePackages?.map((item) => [item.root, item.rulePacks] as const),
  );
  expect(activations.get(".")).toContain("vite-doctor/nitro");
  expect(activations.get(".")).not.toContain("vite-doctor/nuxt");
  expect(activations.get("packages/site")).toEqual(
    expect.arrayContaining(["vite-doctor/nuxt", "vite-doctor/vue", "vite-doctor/nitro"]),
  );
  expect(activations.get("packages/app")).toContain("vite-doctor/vue");
  expect(activations.get("packages/app")).not.toContain("vite-doctor/nuxt");
});

test("pnpm workspace declarations take precedence and support multiline flow sequences", async () => {
  const root = fixture({
    "package.json": JSON.stringify({ workspaces: ["apps/*"] }),
    "pnpm-workspace.yaml": 'packages: [\n  "packages/web",\n  "packages/acme,web"\n]\n',
    "packages/web/package.json": JSON.stringify({ name: "web", dependencies: { vue: "^3.5.0" } }),
    "packages/acme,web/package.json": JSON.stringify({
      name: "acme",
      dependencies: { vue: "^3.5.0" },
    }),
    "apps/web/package.json": JSON.stringify({ name: "ignored", dependencies: { nuxt: "4" } }),
  });

  const project = await detectProject(root);

  expect(project.workspacePackages?.map((item) => item.root)).toEqual([
    ".",
    "packages/acme,web",
    "packages/web",
  ]);
});

test("Nuxt inventory is rooted at the workspace package selecting Nuxt", async () => {
  const root = nitroRootMonorepo({
    "packages/site/package.json": JSON.stringify({
      name: "@workspace/site",
      dependencies: { nuxt: "^4.0.0" },
    }),
    "packages/site/nuxt.config.ts": "export default defineNuxtConfig({ routeRules: {} })\n",
    "packages/site/app/app.vue": button,
    "packages/site/server/api/hello.ts": "export default defineEventHandler(() => 'hello')\n",
    "packages/site/.nuxt/doctor.manifest.json": JSON.stringify({
      nuxtVersion: "4.0.0",
      appDir: "app",
      modules: [{ name: "@nuxt/image", version: "1.0.0" }],
    }),
  });

  const project = await detectProject(root);

  expect(project.nuxt?.appRoots).toEqual([join(root, "packages/site")]);
  expect(project.nuxt?.appDir).toBe(join(root, "packages/site/app"));
  expect(project.nuxt?.manifestPath).toBe(join(root, "packages/site/.nuxt/doctor.manifest.json"));
  expect(project.nuxt?.serverDirs.api).toEqual([join(root, "packages/site/server/api/hello.ts")]);
  expect(project.nuxt?.modules).toContainEqual({ name: "@nuxt/image", version: "1.0.0" });
});

test("a Nuxt app's modules activate Rule Packs for that app only, not its sibling packages", async () => {
  const root = nitroRootMonorepo({
    "packages/site/package.json": JSON.stringify({
      name: "@workspace/site",
      dependencies: { nuxt: "^4.0.0" },
    }),
    "packages/site/nuxt.config.ts": "export default defineNuxtConfig({ modules: ['@nuxt/ui'] })\n",
    "packages/site/app/app.vue": button,
    "packages/site/.nuxt/doctor.manifest.json": JSON.stringify({
      nuxtVersion: "4.0.0",
      appDir: "app",
      modules: [{ name: "@nuxt/ui", version: "4.0.0" }],
    }),
  });

  const result = await runViteDoctor({ root, cache: false });

  expect(
    result.workspacePackages
      ?.filter((item) => item.rulePacks.includes("vite-doctor/design-system"))
      .map((item) => item.root),
  ).toEqual(["packages/site"]);
});

test("an explicit framework still selects exactly that framework's Rule Packs", async () => {
  const root = nitroRootMonorepo();
  const result = await runViteDoctor({ root, framework: "nitro", cache: false });

  expect(result.framework).toBe("nitro");
  expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).not.toContain(buttonRule);
  expect(
    (await viteDoctorExtensions({ root, framework: "nitro" })).map((extension) => extension.name),
  ).not.toContain("vite-doctor/builtin-vue");
});

test("Project Inventory reads package.json workspaces and negated patterns", async () => {
  const root = fixture({
    "package.json": JSON.stringify({
      name: "workspace",
      workspaces: ["apps/*", "!apps/ignored"],
    }),
    "apps/web/package.json": JSON.stringify({ name: "web", dependencies: { vue: "^3.5.0" } }),
    "apps/ignored/package.json": JSON.stringify({ name: "ignored", dependencies: { nuxt: "4" } }),
    "apps/web/node_modules/dep/package.json": JSON.stringify({ name: "dep" }),
  });

  const project = await detectProject(root);

  expect(project.isMonorepo).toBe(true);
  expect(project.framework).toBe("vue");
  expect(
    project.workspacePackages?.map(({ root, name, framework }) => ({ root, name, framework })),
  ).toEqual([
    { root: ".", name: "workspace", framework: "vite" },
    { root: "apps/web", name: "web", framework: "vue" },
  ]);
});

test("single-package projects keep root Activation unchanged", async () => {
  const root = fixture({
    "package.json": JSON.stringify({ name: "app", dependencies: { vue: "^3.5.0" } }),
    "src/Save.vue": button,
  });

  const result = await runViteDoctor({ root, cache: false });

  expect(result.framework).toBe("vue");
  expect(result.workspacePackages).toEqual([
    expect.objectContaining({ root: ".", framework: "vue" }),
  ]);
  expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toContain(buttonRule);
  expect(JSON.parse(createAgentReport(result, { runOptions: { root } })).commandArgs.rerun[3]).toBe(
    "vue",
  );
});

test("a pnpm declaration without packages does not fall back to manifest workspaces", async () => {
  const root = fixture({
    "package.json": JSON.stringify({ workspaces: ["apps/*"] }),
    "pnpm-workspace.yaml": "catalog: {}\n",
    "apps/web/package.json": JSON.stringify({ dependencies: { nuxt: "4" } }),
  });
  expect((await detectProject(root)).workspacePackages?.map((item) => item.root)).toEqual(["."]);
});

test("nested Nuxt host extensions require explicit trust and use the inventory owner", async () => {
  const root = nitroRootMonorepo({
    "packages/site/package.json": JSON.stringify({ dependencies: { nuxt: "^4.0.0" } }),
    "packages/site/doctor.mjs": "export default { name: 'nested-host' };",
  });
  const manifestDir = join(root, "packages/site/.nuxt");
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(
    join(manifestDir, "doctor.manifest.json"),
    JSON.stringify({
      extensions: [join(root, "packages/site/doctor.mjs")],
    }),
  );
  expect(await hostDoctorExtensions({ root })).toEqual([]);
  expect(await hostDoctorExtensions({ root, hostExtensions: true })).toEqual([
    { name: "nested-host" },
  ]);
});

const plainEnvRule = "nuxt/runtime/no-plain-env-in-app-code";
const plainEnvPage = '<script setup lang="ts">const key = process.env.API_KEY</script>\n';

function multiNuxtMonorepo(members: Record<string, string> = {}) {
  return nitroRootMonorepo({
    "packages/app-a/package.json": JSON.stringify({
      name: "@workspace/app-a",
      dependencies: { nuxt: "^4.0.0" },
    }),
    "packages/app-a/nuxt.config.ts": "export default defineNuxtConfig({})\n",
    "packages/app-a/app/pages/index.vue": plainEnvPage,
    "packages/app-b/package.json": JSON.stringify({
      name: "@workspace/app-b",
      dependencies: { nuxt: "^4.0.0" },
    }),
    "packages/app-b/nuxt.config.ts": "export default defineNuxtConfig({ srcDir: 'web' })\n",
    "packages/app-b/web/pages/index.vue": plainEnvPage,
    "packages/app-b/.nuxt/doctor.manifest.json": JSON.stringify({
      nuxtVersion: "4.0.0",
      appDir: "web",
      modules: [{ name: "docus" }],
    }),
    ...members,
  });
}

test("a workspace with several Nuxt apps reads each app's own Nuxt Project Inventory", async () => {
  const root = multiNuxtMonorepo();

  const project = await detectProject(root);

  expect(project.framework).toBe("nuxt");
  expect(project.nuxt).toBeUndefined();
  expect(project.workspaceNuxt?.map((item) => item.root)).toEqual([
    "packages/app-a",
    "packages/app-b",
  ]);
  const [appA, appB] = project.workspaceNuxt!;
  expect(appA!.nuxt.appDir).toBe(join(root, "packages/app-a/app"));
  expect(appB!.nuxt.appDir).toBe(join(root, "packages/app-b/web"));
  expect(appB!.nuxt.manifestPath).toBe(join(root, "packages/app-b/.nuxt/doctor.manifest.json"));
  expect((appA!.nuxt.modules ?? []).map((module) => module.name)).not.toContain("docus");
  expect((appB!.nuxt.modules ?? []).map((module) => module.name)).toContain("docus");
  const view = workspaceProjectView(project, "packages/app-b");
  expect(view.nuxt).toBe(appB!.nuxt);
  expect(view.root).toBe(project.root);
});

test("a workspace with several Nuxt apps runs Nuxt Rules on each app with its inventory", async () => {
  const root = multiNuxtMonorepo();

  const result = await runViteDoctor({ root, cache: false, runtimeTarget: { nuxt: "4.1.0" } });

  expect(result.project.framework).toBe("nuxt");
  expect(
    result.diagnostics
      .filter((diagnostic) => diagnostic.ruleId === plainEnvRule)
      .map((diagnostic) => diagnostic.file.slice(root.length + 1)),
  ).toEqual(["packages/app-a/app/pages/index.vue", "packages/app-b/web/pages/index.vue"]);
  const activations = new Map(
    result.workspacePackages?.map((item) => [item.root, item.rulePacks] as const),
  );
  expect(activations.get(".")).not.toContain("vite-doctor/nuxt");
  expect(activations.get("packages/app-a")).toContain("vite-doctor/nuxt");
  expect(activations.get("packages/app-b")).toEqual(
    expect.arrayContaining(["vite-doctor/nuxt", "vite-doctor/docus"]),
  );
  expect(activations.get("packages/app-a")).not.toContain("vite-doctor/docus");
  expect(activations.get("packages/app")).not.toContain("vite-doctor/nuxt");
  expect(result.project.evidenceGaps ?? []).toEqual([]);
  expect(JSON.parse(createJsonReport(result)).workspacePackages).toHaveLength(5);
});

test("island plugin registration gaps identify each affected Nuxt app", async () => {
  const auth = "export default defineNuxtPlugin({ name: 'auth', env: { islands: false } })";
  const api = "export default defineNuxtPlugin({ name: 'api', dependsOn: ['auth'] })";
  const root = multiNuxtMonorepo({
    "packages/app-a/app/components/Chart.server.vue": button,
    "packages/app-a/app/plugins/auth.ts": auth,
    "packages/app-a/app/plugins/api.ts": api,
    "packages/app-b/web/components/Chart.server.vue": button,
    "packages/app-b/web/plugins/auth.ts": auth,
    "packages/app-b/web/plugins/api.ts": api,
  });
  rmSync(join(root, "packages/app-b/.nuxt/doctor.manifest.json"));
  const scan = async () => {
    const result = await runViteDoctor({ root, cache: false, runtimeTarget: { nuxt: "4.5.2" } });
    expect(result.diagnostics.map(({ code }) => code)).not.toContain("NUXT0104");
    return (result.project.evidenceGaps ?? [])
      .filter(
        ({ source }) => source === "nuxt/plugins/no-island-disabled-dependency/island-registration",
      )
      .flatMap(({ files }) => files)
      .sort();
  };
  expect(await scan()).toEqual([
    "packages/app-a/.nuxt/doctor.manifest.json",
    "packages/app-b/.nuxt/doctor.manifest.json",
  ]);

  writeFileSync(
    join(root, "packages/app-a/nuxt.config.ts"),
    "export default defineNuxtConfig({ experimental: { componentIslands: false } })",
  );
  expect(await scan()).toEqual([
    "packages/app-a/.nuxt/doctor.manifest.json",
    "packages/app-b/.nuxt/doctor.manifest.json",
  ]);
  mkdirSync(join(root, "packages/app-a/.nuxt"), { recursive: true });
  writeFileSync(
    join(root, "packages/app-a/.nuxt/doctor.manifest.json"),
    JSON.stringify({
      generatedAt: new Date(Date.now() + 10_000).toISOString(),
      componentIslands: false,
    }),
  );
  expect(await scan()).toEqual(["packages/app-b/.nuxt/doctor.manifest.json"]);

  rmSync(join(root, "packages/app-b/web/plugins/auth.ts"));
  expect(await scan()).toEqual([]);
});

test.each([
  { path: "../shared/auth.ts", alias: "" },
  { path: "../shared/auth", alias: "" },
  { path: "#shared-auth", alias: "alias: { '#shared-auth': '../shared/auth' }," },
])(
  "checks the shared plugin registered as $path only for its Nuxt app",
  async ({ path, alias }) => {
    const root = multiNuxtMonorepo({
      "packages/shared/package.json": JSON.stringify({ name: "@workspace/shared" }),
      "packages/shared/auth.ts":
        "export default defineNuxtPlugin({ name: 'auth', env: { islands: false } })",
      "packages/app-a/nuxt.config.ts": `export default defineNuxtConfig({ ${alias} plugins: ['${path}'] })`,
      "packages/app-a/app/components/Chart.server.vue": button,
      "packages/app-a/app/plugins/api.ts":
        "export default defineNuxtPlugin({ name: 'api', dependsOn: ['auth'] })",
      "packages/app-b/web/components/Chart.server.vue": button,
      "packages/app-b/web/plugins/api.ts":
        "export default defineNuxtPlugin({ name: 'api', dependsOn: ['auth'] })",
    });
    const scan = () => runViteDoctor({ root, cache: false, runtimeTarget: { nuxt: "4.5.2" } });
    const result = await scan();
    expect(result.diagnostics.map(({ code }) => code)).not.toContain("NUXT0104");
    expect(
      result.project.evidenceGaps
        ?.filter(
          ({ source }) =>
            source === "nuxt/plugins/no-island-disabled-dependency/island-registration",
        )
        .flatMap(({ files }) => files),
    ).toEqual(["packages/app-a/.nuxt/doctor.manifest.json"]);

    const app = join(root, "packages/app-a");
    symlinkSync(
      fileURLToPath(new URL("../../node_modules", import.meta.url)),
      join(root, "node_modules"),
      "junction",
    );
    const cwd = process.cwd();
    let nuxt: Awaited<ReturnType<typeof loadNuxt>> | undefined;
    try {
      process.chdir(app);
      nuxt = await loadNuxt({
        cwd: app,
        overrides: { _prepare: true, telemetry: false, modules: [nuxtDoctorModule] },
      });
      await buildNuxt(nuxt);
      const prepared = await scan();
      expect(prepared.diagnostics.filter(({ code }) => code === "NUXT0104")).toMatchObject([
        {
          file: expect.stringMatching(/packages\/app-a\/app\/plugins\/api\.ts$/),
          related: [{ file: expect.stringMatching(/packages\/shared\/auth\.ts$/) }],
        },
      ]);
      expect(
        prepared.project.evidenceGaps?.filter(({ source }) =>
          source.startsWith("nuxt/plugins/no-island-disabled-dependency/"),
        ) ?? [],
      ).toEqual([]);
    } finally {
      await nuxt?.close();
      process.chdir(cwd);
    }
  },
);

test("Nuxt manifest Rules review each Nuxt app's inventory", async () => {
  const root = multiNuxtMonorepo({
    "packages/app/node_modules/vue/package.json": JSON.stringify({ name: "vue", version: "3.5.0" }),
    "node_modules/nitro/package.json": JSON.stringify({ name: "nitro", version: "3.0.0" }),
    "node_modules/nitro/node_modules/h3/package.json": JSON.stringify({
      name: "h3",
      version: "2.0.8",
    }),
    "packages/app-b/.nuxt/doctor.manifest.json": JSON.stringify({
      nuxtVersion: "4.0.0",
      appDir: "web",
      autoImports: [
        { name: "useFoo", from: "~/composables/a" },
        { name: "useFoo", from: "~/composables/b" },
      ],
    }),
  });

  const result = await runViteDoctor({
    root,
    cache: false,
    rules: "nuxt/imports/no-auto-import-collision",
    runtimeTarget: { nuxt: "4.1.0" },
  });

  expect(
    result.diagnostics
      .filter((diagnostic) => diagnostic.ruleId === "nuxt/imports/no-auto-import-collision")
      .map((diagnostic) => diagnostic.file.slice(root.length + 1)),
  ).toEqual(["packages/app-b/nuxt.config.ts"]);
  expect(
    result.diagnostics
      .filter((diagnostic) => diagnostic.ruleId === "doctor/inventory/unresolved-runtime")
      .map((diagnostic) => diagnostic.file.slice(root.length + 1)),
  ).toEqual(["packages/app-a/package.json", "packages/app-b/package.json"]);
});

test("Nuxt manifest findings from a single nested app use an in-package fallback", async () => {
  const root = fixture({
    "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
    "build.config.ts": "export default {}\n",
    "packages/site/package.json": JSON.stringify({ dependencies: { nuxt: "^4.0.0" } }),
    "packages/site/.nuxt/doctor.manifest.json": JSON.stringify({
      nuxtVersion: "4.0.0",
      autoImports: [
        { name: "useFoo", from: "~/composables/a" },
        { name: "useFoo", from: "~/composables/b" },
      ],
    }),
  });
  const result = await runViteDoctor({ root, cache: false, runtimeTarget: { nuxt: "4.1.0" } });
  expect(
    result.diagnostics
      .filter((diagnostic) => diagnostic.code === "NUXT0034")
      .map((diagnostic) => diagnostic.file.slice(root.length + 1)),
  ).toEqual(["packages/site/.nuxt/doctor.manifest.json"]);
});

test("Nuxt module Doctor options of a non-owning Nuxt app are reported as an evidence gap", async () => {
  const root = multiNuxtMonorepo({
    "packages/app-a/.nuxt/doctor.manifest.json": JSON.stringify({
      nuxtVersion: "4.0.0",
      doctorConfig: { rules: { [plainEnvRule]: "off" } },
    }),
  });

  const result = await runViteDoctor({ root, cache: false, runtimeTarget: { nuxt: "4.1.0" } });

  expect(result.project.evidenceGaps).toEqual([
    {
      source: "vite-doctor/workspace-nuxt",
      message: expect.stringContaining("Run Doctor from packages/app-a"),
      files: ["packages/app-a/.nuxt/doctor.manifest.json"],
    },
  ]);
  expect(JSON.parse(createAgentReport(result, { runOptions: { root } })).status).toBe("incomplete");
});

test("an explicit Nuxt run with several Nuxt apps roots the run inventory at the workspace", async () => {
  const root = multiNuxtMonorepo();

  const project = await detectProject(root, "nuxt");

  expect(project.nuxt?.appRoots).toEqual([
    join(root, "packages/app-a"),
    join(root, "packages/app-b"),
  ]);
  expect(project.workspaceNuxt?.map((item) => item.root)).toEqual([
    "packages/app-a",
    "packages/app-b",
  ]);
  const result = await runViteDoctor({
    root,
    framework: "nuxt",
    cache: false,
    runtimeTarget: { nuxt: "4.1.0" },
  });
  expect(
    result.diagnostics
      .filter((diagnostic) => diagnostic.ruleId === plainEnvRule)
      .map((diagnostic) => diagnostic.file.slice(root.length + 1)),
  ).toEqual(["packages/app-a/app/pages/index.vue", "packages/app-b/web/pages/index.vue"]);
});

test("host extensions load from every Nuxt app's manifest", async () => {
  const root = multiNuxtMonorepo({
    "packages/app-a/doctor.mjs": "export default { name: 'app-a-host' };",
    "packages/app-b/doctor.mjs": "export default { name: 'app-b-host' };",
  });
  for (const app of ["app-a", "app-b"]) {
    mkdirSync(join(root, `packages/${app}/.nuxt`), { recursive: true });
    writeFileSync(
      join(root, `packages/${app}/.nuxt/doctor.manifest.json`),
      JSON.stringify({ extensions: [join(root, `packages/${app}/doctor.mjs`)] }),
    );
  }
  expect(await hostDoctorExtensions({ root, hostExtensions: true })).toEqual([
    { name: "app-a-host" },
    { name: "app-b-host" },
  ]);
});

test("a root Nuxt owner can include a nested Nuxt workspace package", async () => {
  const root = nitroRootMonorepo({
    "package.json": JSON.stringify({ dependencies: { nuxt: "^4.0.0" } }),
    "packages/site/package.json": JSON.stringify({ dependencies: { nuxt: "^4.0.0" } }),
  });
  expect((await detectProject(root)).framework).toBe("nuxt");
});

test("cached runs of a workspace with several Nuxt apps equal uncached runs for each app", async () => {
  const root = multiNuxtMonorepo();
  const options = { root, runtimeTarget: { nuxt: "4.1.0" } };
  const comparable = (result: Awaited<ReturnType<typeof runViteDoctor>>) =>
    result.diagnostics.map(({ diagnostic, ...rest }) => ({ ...rest, code: diagnostic.name }));
  const expectParity = async () => {
    const cached = await runViteDoctor({ ...options, cache: true });
    expect(comparable(cached)).toEqual(
      comparable(await runViteDoctor({ ...options, cache: false })),
    );
    return cached;
  };

  await expectParity();
  await expectParity();
  writeFileSync(
    join(root, "packages/app-b/.nuxt/doctor.manifest.json"),
    JSON.stringify({
      nuxtVersion: "4.0.0",
      appDir: "web",
      autoImports: [
        { name: "useFoo", from: "~/composables/a" },
        { name: "useFoo", from: "~/composables/b" },
      ],
    }),
  );
  mkdirSync(join(root, "packages/app-a/.nuxt"), { recursive: true });
  writeFileSync(
    join(root, "packages/app-a/.nuxt/doctor.manifest.json"),
    JSON.stringify({
      nuxtVersion: "4.0.0",
      appDir: "app",
      autoImports: [
        { name: "useBar", from: "~/composables/c" },
        { name: "useBar", from: "~/composables/d" },
      ],
    }),
  );
  const collisions = (await expectParity()).diagnostics.filter(
    (diagnostic) => diagnostic.ruleId === "nuxt/imports/no-auto-import-collision",
  );
  expect(collisions.map((diagnostic) => diagnostic.file.slice(root.length + 1))).toEqual([
    "packages/app-a/app/pages/index.vue",
    "packages/app-b/nuxt.config.ts",
  ]);
  // Each Nuxt app's manifest Rule result is replayed for that app only.
  writeFileSync(join(root, "packages/app-a/app/pages/index.vue"), button);
  await expectParity();
  await expectParity();
});
