import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { runViteDoctor } from "../../../src/doctor.js";
import { withPackage } from "./fixture.js";

const RULE = "package/no-unforwarded-peer";

async function unforwarded(packages: Record<string, object>, files: Record<string, string> = {}) {
  return withPackage(
    { private: true },
    {
      "pnpm-workspace.yaml":
        "packages:\n  - packages/*\ncatalogs:\n  database:\n    drizzle-orm: '>=1.0.0-rc.5 <2.0.0'\n",
      ...Object.fromEntries(
        Object.entries(packages).map(([name, manifest]) => [
          `packages/${name}/package.json`,
          JSON.stringify({ name: `@x/${name}`, ...manifest }),
        ]),
      ),
      ...files,
    },
    async (root) => {
      const result = await runViteDoctor({
        root,
        framework: "vite",
        cache: false,
        extends: ["package/recommended"],
      });
      return {
        root,
        diagnostics: result.diagnostics.filter((diagnostic) => diagnostic.ruleId === RULE),
      };
    },
  );
}

const auth = {
  peerDependencies: { "drizzle-orm": "catalog:database", vue: "^3.5.0", vite: "^8.0.0" },
  peerDependenciesMeta: { vite: { optional: true } },
};

test("reports a workspace dependency's required peer that the dependent does not declare", async () => {
  const { root, diagnostics } = await unforwarded({
    auth,
    realtime: {
      dependencies: { "@x/auth": "workspace:*" },
      devDependencies: { "drizzle-orm": "catalog:database" },
      peerDependencies: { vue: "^3.5.0" },
    },
  });
  expect(diagnostics).toHaveLength(1);
  const [diagnostic] = diagnostics;
  expect(diagnostic).toMatchObject({
    code: "PKG0007",
    file: join(root, "packages/realtime/package.json"),
    confidence: "manifest-backed",
  });
  expect(diagnostic!.message).toContain('"@x/auth"');
  expect(diagnostic!.message).toContain('"drizzle-orm"');
  expect(diagnostic!.message).toContain("only a development dependency");
  expect(diagnostic!.suggestion).toContain('"drizzle-orm": "catalog:database"');
  expect(diagnostic!.evidence?.map((item) => item.file)).toEqual([
    join(root, "packages/realtime/package.json"),
    join(root, "packages/auth/package.json"),
  ]);
});

test("accepts forwarded peers, own dependencies, optional peers and peer-only workspace packages", async () => {
  const { diagnostics } = await unforwarded({
    auth,
    peered: {
      dependencies: { "@x/auth": "workspace:*" },
      peerDependencies: { "drizzle-orm": ">=1.0.0-rc.5 <2.0.0", vue: "^3.5.0" },
      peerDependenciesMeta: { "drizzle-orm": { optional: true } },
    },
    owned: {
      dependencies: { "@x/auth": "workspace:^", "drizzle-orm": "catalog:database" },
      optionalDependencies: { vue: "^3.5.0" },
    },
    hosted: {
      peerDependencies: { "@x/auth": "workspace:*" },
    },
    tested: {
      devDependencies: { "@x/auth": "workspace:*" },
    },
    internal: {
      private: true,
      dependencies: { "@x/auth": "workspace:*" },
    },
  });
  expect(diagnostics).toEqual([]);
});

test("reports each missing peer once per workspace dependency, through optionalDependencies too", async () => {
  const { diagnostics } = await unforwarded({
    auth,
    comments: { peerDependencies: { vue: "^3.5.0", "@x/database": "workspace:*" } },
    database: {},
    ui: {
      dependencies: { "@x/auth": "workspace:*" },
      optionalDependencies: { "@x/comments": "workspace:*" },
    },
  });
  expect(
    diagnostics
      .map((d) => d.message.match(/peer "([^"]+)"/)?.[1] ?? "")
      .sort((a, b) => a.localeCompare(b)),
  ).toEqual(["@x/database", "drizzle-orm", "vue", "vue"]);
});

test("does not borrow peer contracts from uncertain registry targets or compatible default peers", async () => {
  expect(
    (
      await unforwarded({
        auth: { version: "2.0.0", peerDependencies: { vue: "^3.0.0" } },
        registry: { dependencies: { "@x/auth": "^1.0.0" } },
        fallback: { dependencies: { vue: "^3.5.0" }, peerDependencies: { vue: "^3.0.0" } },
        consumer: { dependencies: { "@x/fallback": "workspace:*" } },
      })
    ).diagnostics,
  ).toEqual([]);
});

test("package-local runs use sibling context without reporting sibling manifests", async () => {
  await withPackage(
    { private: true },
    {
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/auth/package.json": JSON.stringify({
        name: "auth",
        peerDependencies: { "drizzle-orm": "^1.0.0" },
      }),
      "packages/vue/package.json": JSON.stringify({
        name: "vue",
        version: "3.6.0",
        peerDependencies: { vite: "1.0.0" },
      }),
      "packages/realtime/package.json": JSON.stringify({
        name: "realtime",
        dependencies: { auth: "workspace:*" },
        peerDependencies: { vue: "workspace:*" },
      }),
    },
    async (root) => {
      for (const runRoot of [root, join(root, "packages/realtime")]) {
        const result = await runViteDoctor({
          root: runRoot,
          framework: "vite",
          cache: false,
          extends: ["package/recommended"],
        });
        const relevant = result.diagnostics.filter(
          (d) =>
            ["PKG0005", "PKG0007"].includes(d.code) &&
            d.file === join(root, "packages/realtime/package.json"),
        );
        expect(relevant.map((d) => d.code).sort()).toEqual(["PKG0005", "PKG0007"]);
        if (runRoot !== root)
          expect(
            result.diagnostics.filter((d) => ["PKG0005", "PKG0007"].includes(d.code)),
          ).toHaveLength(2);
      }
    },
  );
});
