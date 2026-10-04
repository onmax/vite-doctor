import { expect, test } from "vite-plus/test";
import { runNuxtManifestRuleFixture } from "../../../src/core/testkit.ts";
import { noAutoImportCollision } from "../../../src/rule-packs/nuxt/rules/nuxt/no-auto-import-collision.ts";

test("reports duplicate auto-import names from distinct sources", async () => {
  const result = await runNuxtManifestRuleFixture(noAutoImportCollision, {
    ".nuxt/doctor.manifest.json": JSON.stringify({
      nuxtVersion: "4.5.1",
      vueVersion: "3.5.0",
      rootDir: "/project",
      srcDir: "app",
      appDir: "app",
      buildDir: ".nuxt",
      autoImports: [
        { name: "useShared", from: "/project/app/composables/a.ts", kind: "app" },
        { name: "useShared", from: "/project/app/composables/b.ts", kind: "app" },
      ],
      components: [],
      layers: [],
      aliases: {},
      routeRules: {},
    }),
  });

  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      code: "NUXT0034",
      why: expect.stringContaining("/project/app/composables/a.ts"),
    }),
  ]);
  expect(result.diagnostics[0]?.why).toContain("/project/app/composables/b.ts");
});
