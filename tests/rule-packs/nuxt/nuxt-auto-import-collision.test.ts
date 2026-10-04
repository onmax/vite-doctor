import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, test } from "vite-plus/test";
import { join } from "pathe";
import { runNuxtManifestRuleFixture } from "../../../src/core/testkit.ts";
import nuxtDoctorModule from "../../../src/rule-packs/nuxt/module.ts";
import { noAutoImportCollision } from "../../../src/rule-packs/nuxt/rules/nuxt/no-auto-import-collision.ts";

async function runCollisionFixture(autoImports: unknown[]) {
  return runNuxtManifestRuleFixture(noAutoImportCollision, {
    ".nuxt/doctor.manifest.json": JSON.stringify({
      nuxtVersion: "4.5.1",
      vueVersion: "3.5.0",
      rootDir: "/project",
      srcDir: "app",
      appDir: "app",
      buildDir: ".nuxt",
      autoImports,
      components: [],
      layers: [],
      aliases: {},
      routeRules: {},
    }),
  });
}

test("reports duplicate auto-import names from distinct sources", async () => {
  const result = await runCollisionFixture([
    { name: "useShared", from: "/project/app/composables/a.ts", kind: "app" },
    { name: "useShared", from: "/project/app/composables/b.ts", kind: "app" },
  ]);

  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      code: "NUXT0034",
      why: expect.stringContaining("/project/app/composables/a.ts"),
    }),
  ]);
  expect(result.diagnostics[0]?.why).toContain("/project/app/composables/b.ts");
});

test("reports collisions between distinct aliases while preserving the lookup winner", async () => {
  const result = await runCollisionFixture([
    {
      name: "usePrimary",
      as: "useShared",
      from: "/project/app/composables/primary.ts",
      kind: "app",
    },
    {
      name: "useSecondary",
      as: "useShared",
      from: "/project/app/composables/secondary.ts",
      kind: "app",
    },
  ]);

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.why).toContain("'useShared'");
  expect(result.diagnostics[0]?.why).toContain("primary.ts");
  expect(result.diagnostics[0]?.why).toContain("secondary.ts");
  expect(result.project.nuxt?.autoImports.get("useShared")?.from).toContain("secondary.ts");
  expect(result.project.nuxt?.autoImportEntries?.map((entry) => entry.from)).toEqual([
    "/project/app/composables/primary.ts",
    "/project/app/composables/secondary.ts",
  ]);
});

test("ignores repeated auto-import entries from the same source", async () => {
  const result = await runCollisionFixture([
    { name: "useShared", from: "/project/app/composables/shared.ts", kind: "app" },
    { name: "useShared", from: "/project/app/composables/shared.ts", kind: "app" },
  ]);

  expect(result.diagnostics).toEqual([]);
});

test("ignores type-only duplicates", async () => {
  const result = await runCollisionFixture([
    { name: "SharedType", type: true, from: "/project/app/composables/a.ts", kind: "app" },
    { name: "SharedType", type: true, from: "/project/app/composables/b.ts", kind: "app" },
  ]);

  expect(result.diagnostics).toEqual([]);
});

test("ignores disabled entries and lower-priority overrides", async () => {
  const result = await runCollisionFixture([
    {
      name: "useShared",
      from: "/project/layers/base/composables/shared.ts",
      kind: "layer",
      priority: -1,
    },
    {
      name: "useShared",
      from: "/project/app/composables/shared.ts",
      kind: "app",
      priority: 0,
    },
    {
      name: "useDisabled",
      from: "/project/app/composables/disabled.ts",
      kind: "app",
      disabled: true,
    },
    {
      name: "useDisabled",
      from: "/project/app/composables/other.ts",
      kind: "app",
      disabled: true,
    },
  ]);

  expect(result.diagnostics).toEqual([]);
});

test("Nuxt imports extend keeps duplicate entries in the generated manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "vite-doctor-nuxt-imports-"));
  const hooks = new Map<string, Array<(payload: any) => unknown>>();
  const nuxt = {
    _version: "4.5.1",
    options: {
      rootDir: root,
      srcDir: "app",
      buildDir: ".nuxt",
      modules: [],
      imports: { autoImport: true, imports: [], transform: { include: [], exclude: [] } },
    },
    hook(name: string, callback: (payload: any) => unknown) {
      hooks.set(name, [...(hooks.get(name) ?? []), callback]);
    },
    async callHook() {},
  };

  try {
    await nuxtDoctorModule({}, nuxt as any);
    for (const hook of hooks.get("imports:context") ?? [])
      await hook({
        getImports: () => [
          { name: "useRoute", from: "#app/composables/router" },
          { name: "useShared", from: join(root, "app/composables/a.ts"), priority: 1 },
        ],
      });
    const rawImports: Array<{ name: string; from: string; priority?: number }> = [
      { name: "useShared", from: join(root, "app/composables/a.ts"), priority: 2 },
      { name: "useShared", from: join(root, "app/composables/b.ts"), priority: 2 },
    ];
    for (const hook of hooks.get("imports:extend") ?? []) await hook(rawImports);
    rawImports.push({ name: "useShared", from: join(root, "app/composables/c.ts") });
    for (const hook of hooks.get("prepare:types") ?? []) await hook(undefined);

    const manifest = JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8"));
    expect(manifest.autoImports).toHaveLength(5);
    expect(manifest.autoImports.map((entry: { from: string }) => entry.from)).toEqual([
      join(root, "app/composables/a.ts"),
      join(root, "app/composables/b.ts"),
      join(root, "app/composables/c.ts"),
      "#app/composables/router",
      join(root, "app/composables/a.ts"),
    ]);
    expect(manifest.autoImports.map((entry: { priority?: number }) => entry.priority)).toEqual([
      2,
      2,
      undefined,
      undefined,
      1,
    ]);
    const result = await runCollisionFixture(manifest.autoImports);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.why).toContain("a.ts");
    expect(result.diagnostics[0]?.why).toContain("b.ts");
    expect(result.project.nuxt?.autoImports.get("useShared")?.priority).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
