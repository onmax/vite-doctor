import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { runViteDoctor } from "../../../src/doctor.js";
import { diagnose, withPackage } from "./fixture.js";

const RULE = "package/no-pinned-singleton";

async function pinned(
  manifest: object,
  files: Record<string, string> = {},
  options?: Record<string, unknown>,
) {
  const diagnostics = await diagnose(manifest, files, {
    config: { rules: options ? { [RULE]: ["warn", options] } : {} },
  });
  return diagnostics.filter((diagnostic) => diagnostic.ruleId === RULE);
}

test("reports an exact peer on a framework singleton at the manifest entry, with a range to use", async () => {
  const manifest = { peerDependencies: { vue: "3.5.44" } };
  await withPackage(manifest, {}, async (root) => {
    const result = await runViteDoctor({
      root,
      framework: "vite",
      cache: false,
      extends: ["package/recommended"],
    });
    const diagnostics = result.diagnostics.filter((d) => d.ruleId === RULE);
    expect(diagnostics).toHaveLength(1);
    const [diagnostic] = diagnostics;
    expect(diagnostic).toMatchObject({
      code: "PKG0005",
      file: join(root, "package.json"),
      confidence: "manifest-backed",
    });
    expect(diagnostic!.message).toContain('peerDependencies "vue": "3.5.44"');
    expect(diagnostic!.suggestion).toContain('"vue": "^3.5.44"');
    expect(diagnostic!.range?.line).toBe(1);
    const text = JSON.stringify({ name: "example-library", ...manifest });
    expect(text.slice(diagnostic!.range!.start, diagnostic!.range!.end)).toBe('"vue":"3.5.44"');
  });
});

test("resolves catalog: peers through pnpm-workspace.yaml and names the catalog", async () => {
  const diagnostics = await pinned(
    { peerDependencies: { vue: "catalog:ui", nuxt: "catalog:", vite: "catalog:compat" } },
    {
      "pnpm-workspace.yaml":
        "packages: []\ncatalog:\n  nuxt: 4.2.0\ncatalogs:\n  ui:\n    vue: 3.5.44\n  compat:\n    vite: '>=7.0.0'\n",
    },
  );
  expect(diagnostics.map((d) => d.code)).toEqual(["PKG0005", "PKG0005"]);
  const [nuxt, vue] = diagnostics.sort((a, b) => a.message.localeCompare(b.message));
  expect(nuxt!.message).toContain('"nuxt": "catalog:"');
  expect(nuxt!.message).toContain("4.2.0");
  expect(vue!.message).toContain('"vue": "catalog:ui"');
  expect(vue!.message).toContain("catalogs.ui");
  expect(vue!.suggestion).toContain('"^3.5.44"');
});

test("reports exact dependencies and optional peers on singletons", async () => {
  const diagnostics = await pinned({
    dependencies: { "vue-router": "4.5.1", h3: "npm:h3@2.0.1" },
    optionalDependencies: { pinia: "=3.0.3" },
    peerDependencies: { react: "19.2.0" },
    peerDependenciesMeta: { react: { optional: true } },
  });
  expect(diagnostics.map((d) => `${d.code} ${d.message.split(" ")[0]}`).sort()).toEqual([
    "PKG0005 peerDependencies",
    "PKG0006 dependencies",
    "PKG0006 dependencies",
    "PKG0006 optionalDependencies",
  ]);
  const dependency = diagnostics.find((d) => d.message.includes("vue-router"))!;
  expect(dependency.suggestion).toContain("peerDependencies");
  expect(dependency.suggestion).toContain('"^4.5.1"');
});

test("treats workspace:* on a singleton as the exact version pnpm publishes", async () => {
  const diagnostics = await pinned(
    { private: true },
    {
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/vue/package.json": JSON.stringify({ name: "vue", version: "3.6.0" }),
      "packages/lib/package.json": JSON.stringify({
        name: "lib",
        peerDependencies: { vue: "workspace:*" },
        devDependencies: { nuxt: "4.2.0" },
      }),
      "packages/ranged/package.json": JSON.stringify({
        name: "ranged",
        peerDependencies: { vue: "workspace:^" },
      }),
    },
  );
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]!.file).toContain("packages/lib/package.json");
  expect(diagnostics[0]!.suggestion).toContain('"workspace:^"');
});

test("accepts ranges, private packages, devDependencies and unresolved catalogs", async () => {
  expect(
    await pinned({
      peerDependencies: {
        vue: "^3.5.0",
        nuxt: ">=4.0.0",
        vite: "7.1.0 || ^8.0.0",
        nitro: "catalog:missing",
        lodash: "4.17.21",
      },
      dependencies: { h3: "^2.0.1", "drizzle-orm": "1.0.0-rc.5 || ^1.0.0" },
      devDependencies: { vue: "3.5.44", react: "19.2.0" },
    }),
  ).toEqual([]);
  expect(await pinned({ private: true, peerDependencies: { vue: "3.5.44" } })).toEqual([]);
});

test("adds configured singletons, including scope wildcards", async () => {
  const manifest = {
    peerDependencies: { comark: "0.9.0", "@ai-sdk/provider": "3.0.1", lodash: "4.17.21" },
  };
  expect(await pinned(manifest)).toEqual([]);
  const diagnostics = await pinned(manifest, {}, { singletons: ["comark", "@ai-sdk/*"] });
  expect(
    diagnostics
      .map((d) => d.message.match(/"([^"]+)":/)?.[1] ?? "")
      .sort((a, b) => a.localeCompare(b)),
  ).toEqual(["@ai-sdk/provider", "comark"]);
});
