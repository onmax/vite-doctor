import { expect, test } from "vite-plus/test";
import { runNuxtManifestRuleFixture } from "../../../src/core/testkit.ts";
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
