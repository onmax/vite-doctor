import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { runViteDoctor } from "../../../src/doctor.js";
import { withPackage } from "./fixture.js";

const RULE = "package/no-duplicate-singleton";

interface Importer {
  manifest: object;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** A pnpm v9 lockfile and the workspace manifests behind its importers. */
function workspace(
  importers: Record<string, Importer>,
  snapshots: Record<string, Record<string, string>>,
  header = "",
) {
  const section = (field: string, entries?: Record<string, string>) =>
    entries && Object.keys(entries).length
      ? `    ${field}:\n${Object.entries(entries)
          .map(
            ([name, version]) =>
              `      '${name}':\n        specifier: '*'\n        version: '${version}'\n`,
          )
          .join("")}`
      : "";
  const lockfile = [
    header,
    "lockfileVersion: '9.0'\n\nimporters:\n\n",
    ...Object.entries(importers).map(
      ([path, importer]) =>
        `  ${path}:\n${section("dependencies", importer.dependencies)}${section("devDependencies", importer.devDependencies)}\n`,
    ),
    "snapshots:\n\n",
    ...Object.entries(snapshots).map(([key, dependencies]) =>
      Object.keys(dependencies).length
        ? `  '${key}':\n    dependencies:\n${Object.entries(dependencies)
            .map(([name, version]) => `      '${name}': '${version}'\n`)
            .join("")}\n`
        : `  '${key}': {}\n\n`,
    ),
  ].join("");
  return {
    "pnpm-lock.yaml": lockfile,
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    ...Object.fromEntries(
      Object.entries(importers)
        .filter(([path]) => path !== ".")
        .map(([path, importer]) => [`${path}/package.json`, JSON.stringify(importer.manifest)]),
    ),
  };
}

async function duplicates(
  files: Record<string, string>,
  rootManifest: object = { private: true },
  options?: Record<string, unknown>,
) {
  return withPackage(rootManifest, files, async (root) => {
    const result = await runViteDoctor({
      root,
      framework: "vite",
      cache: false,
      extends: ["package/recommended"],
      config: options ? { rules: { [RULE]: ["warn", options] } } : undefined,
    });
    return {
      root,
      diagnostics: result.diagnostics.filter((diagnostic) => diagnostic.ruleId === RULE),
    };
  });
}

const vueSnapshots = {
  "vue@3.5.44": {},
  "vue@3.4.0": {},
  "old-ui@1.0.0(vue@3.4.0)": { vue: "3.4.0" },
};

test("reports two versions of a singleton reachable from one importer where the extra copy enters", async () => {
  const files = workspace(
    {
      ".": { manifest: {}, devDependencies: { lib: "link:packages/lib" } },
      "packages/lib": {
        manifest: { name: "lib", dependencies: { vue: "^3.5.0", "old-ui": "1.0.0" } },
        dependencies: { vue: "3.5.44", "old-ui": "1.0.0(vue@3.4.0)" },
      },
    },
    vueSnapshots,
  );
  const { root, diagnostics } = await duplicates(files);
  expect(diagnostics).toHaveLength(1);
  const [diagnostic] = diagnostics;
  expect(diagnostic).toMatchObject({
    code: "PKG0008",
    file: join(root, "packages/lib/package.json"),
    confidence: "manifest-backed",
  });
  expect(diagnostic!.message).toContain("vue resolves to 3.5.44 and 3.4.0");
  expect(diagnostic!.message).toContain("packages/lib > old-ui > vue");
  expect(diagnostic!.suggestion).toContain("old-ui");
  expect(diagnostic!.suggestion).toContain('"vue": "3.5.44"');
  const manifest = JSON.stringify({
    name: "lib",
    dependencies: { vue: "^3.5.0", "old-ui": "1.0.0" },
  });
  expect(manifest.slice(diagnostic!.range!.start, diagnostic!.range!.end)).toBe('"old-ui":"1.0.0"');
  expect(diagnostic!.evidence?.[0]?.file).toBe(join(root, "pnpm-lock.yaml"));
  // Each copy cites the lockfile entries on its route, so a --since run can
  // report a duplicate that only a lockfile change adds.
  const lockfile = files["pnpm-lock.yaml"];
  expect(
    diagnostic!.evidence
      ?.filter((item) => item.file === join(root, "pnpm-lock.yaml"))
      .map((item) => lockfile.slice(item.range!.start, item.range!.end)),
  ).toEqual([
    "'vue':\n        specifier: '*'\n        version: '3.5.44'",
    "'old-ui':\n        specifier: '*'\n        version: '1.0.0(vue@3.4.0)'",
    "'vue': '3.4.0'",
  ]);
});

test("reports an app whose separate workspace dependencies bring different copies", async () => {
  const { root, diagnostics } = await duplicates(
    workspace(
      {
        "packages/app": {
          manifest: {
            name: "app",
            private: true,
            dependencies: { a: "workspace:*", b: "workspace:*" },
          },
          dependencies: { a: "link:../a", b: "link:../b" },
        },
        "packages/a": { manifest: { name: "a" }, dependencies: { vue: "3.5.44" } },
        "packages/b": { manifest: { name: "b" }, dependencies: { "old-ui": "1.0.0(vue@3.4.0)" } },
      },
      vueSnapshots,
    ),
  );
  expect(diagnostics.map((d) => d.file)).toEqual([join(root, "packages/app/package.json")]);
  expect(diagnostics[0]!.message).toContain("packages/app > b > old-ui > vue");
});

test("keeps the version an importer declares itself and points at the dependency that adds another", async () => {
  const { root, diagnostics } = await duplicates(
    workspace(
      {
        "packages/app": {
          manifest: {
            name: "app",
            private: true,
            devDependencies: { nuxt: "4.5.2", cli: "^1.0.0" },
          },
          devDependencies: { nuxt: "4.5.2", cli: "1.0.0" },
        },
      },
      { "nuxt@4.5.2": {}, "nuxt@4.6.4": {}, "cli@1.0.0": { nuxt: "4.6.4" } },
    ),
  );
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]!.message).toContain("nuxt resolves to 4.5.2 and 4.6.4");
  expect(diagnostics[0]!.suggestion).toContain("Update cli to a release that accepts nuxt 4.5.2");
  const manifest = JSON.stringify({
    name: "app",
    private: true,
    devDependencies: { nuxt: "4.5.2", cli: "^1.0.0" },
  });
  expect(manifest.slice(diagnostics[0]!.range!.start, diagnostics[0]!.range!.end)).toBe(
    '"cli":"^1.0.0"',
  );
  expect(diagnostics[0]!.file).toBe(join(root, "packages/app/package.json"));
});

test("ignores other majors, peer variants of one version and non-singletons", async () => {
  const { diagnostics } = await duplicates(
    workspace(
      {
        "packages/lib": {
          manifest: { name: "lib" },
          dependencies: {
            h3: "2.0.1",
            unstorage: "1.17.0",
            vue: "3.5.44(typescript@5.9.0)",
            "vue-ui": "1.0.0(vue@3.5.44)",
            lodash: "4.17.21",
            legacy: "1.0.0",
          },
        },
      },
      {
        "h3@2.0.1": {},
        "h3@1.15.4": {},
        "unstorage@1.17.0": { h3: "1.15.4" },
        "vue@3.5.44(typescript@5.9.0)": {},
        "vue@3.5.44": {},
        "vue-ui@1.0.0(vue@3.5.44)": { vue: "3.5.44" },
        "lodash@4.17.21": {},
        "lodash@4.17.20": {},
        "legacy@1.0.0": { lodash: "4.17.20" },
      },
    ),
  );
  expect(diagnostics).toEqual([]);
});

test("adds configured singletons, follows aliases and reads multi-document lockfiles", async () => {
  const files = workspace(
    {
      "packages/agent": {
        manifest: { name: "agent", dependencies: { "@ai-sdk/gateway": "^3.0.0", ai: "^6.0.0" } },
        dependencies: { "@ai-sdk/gateway": "3.0.2", ai: "my-ai@6.0.1" },
      },
    },
    {
      "@ai-sdk/gateway@3.0.2": {},
      "@ai-sdk/gateway@3.0.1": {},
      "my-ai@6.0.1": { "@ai-sdk/gateway": "3.0.1" },
    },
    "---\nlockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    configDependencies: {}\n\n---\n",
  );
  expect((await duplicates(files)).diagnostics).toEqual([]);
  const { diagnostics } = await duplicates(files, { private: true }, { singletons: ["@ai-sdk/*"] });
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]!.message).toContain("@ai-sdk/gateway resolves to 3.0.2 and 3.0.1");
  expect(diagnostics[0]!.message).toContain("packages/agent > ai > @ai-sdk/gateway");
});

test("does not report duplicates from a malformed lockfile with duplicate snapshot keys", async () => {
  const files = workspace(
    { ".": { manifest: {}, dependencies: { vue: "3.5.44", "old-ui": "1.0.0" } } },
    { "old-ui@1.0.0": { vue: "3.5.44" }, "vue@3.5.44": {}, "vue@3.4.0": {} },
  );
  files["pnpm-lock.yaml"] += "  'old-ui@1.0.0':\n    dependencies:\n      vue: '3.4.0'\n";
  const { diagnostics } = await duplicates(files, {
    name: "app",
    dependencies: { vue: "3.5.44", "old-ui": "1.0.0" },
  });
  expect(diagnostics).toEqual([]);
});

test("reports nothing without a pnpm lockfile", async () => {
  const { diagnostics } = await duplicates({
    "packages/lib/package.json": JSON.stringify({ name: "lib", dependencies: { vue: "^3.5.0" } }),
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
  });
  expect(diagnostics).toEqual([]);
});

test("retains a deterministic reporter for workspace cycles and scoped inherited duplicates", async () => {
  const files = workspace(
    {
      "packages/a": { manifest: { name: "a" }, dependencies: { b: "link:../b", vue: "3.5.44" } },
      "packages/b": { manifest: { name: "b" }, dependencies: { a: "link:../a", vue: "3.4.0" } },
    },
    vueSnapshots,
  );
  expect((await duplicates(files)).diagnostics).toHaveLength(1);
  await withPackage({ private: true }, files, async (root) => {
    const result = await runViteDoctor({
      root: join(root, "packages/b"),
      framework: "vite",
      cache: false,
      extends: ["package/recommended"],
    });
    expect(result.diagnostics.filter((d) => d.ruleId === RULE)).toHaveLength(1);
  });
});

test("reports inherited duplicates in a package-local run when their owner is out of scope", async () => {
  const files = workspace(
    {
      "packages/app": { manifest: { name: "app" }, dependencies: { lib: "link:../lib" } },
      "packages/lib": {
        manifest: { name: "lib" },
        dependencies: { vue: "3.5.44", "old-ui": "1.0.0(vue@3.4.0)" },
      },
    },
    vueSnapshots,
  );
  expect((await duplicates(files)).diagnostics).toHaveLength(1);
  await withPackage({ private: true }, files, async (root) => {
    const result = await runViteDoctor({
      root: join(root, "packages/app"),
      framework: "vite",
      cache: false,
      extends: ["package/recommended"],
    });
    expect(result.diagnostics.filter((d) => d.ruleId === RULE).map((d) => d.file)).toEqual([
      join(root, "packages/app/package.json"),
    ]);
  });
});
