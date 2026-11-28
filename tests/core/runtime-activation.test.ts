import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import Module from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { expect, test } from "vite-plus/test";
import { allDiagnostics, runDoctor } from "../../src/core/index.ts";
import { createRule, defineDoctorExtension, defineRulePack } from "../../src/extension.ts";
import type { DoctorRunResult } from "../../src/core/primitives.ts";

const h3v2Rule = createRule({
  meta: {
    id: "test-h3/v2-only",
    title: "H3 v2 only",
    category: "correctness",
    severity: "warn",
    requires: { script: true },
    applicability: { runtimes: { h3: ">=2.0.0-0" }, includePrerelease: true },
  },
  create(ctx) {
    return {
      Program() {
        ctx.report(
          allDiagnostics.DOC9999({
            why: "An h3 v2 file was visited.",
            fix: "Inspect the test diagnostic.",
          }),
          { ruleId: "test-h3/v2-only", severity: "warn", category: "correctness" },
        );
      },
    };
  },
});

const h3Pack = defineRulePack({
  name: "test-h3",
  version: "0.0.0",
  activation: { runtimes: ["h3"] },
  rules: [h3v2Rule],
  presets: { recommended: [h3v2Rule.meta.id] },
});

const runH3Doctor = (root: string) =>
  runDoctor({
    root,
    cache: false,
    extensions: [defineDoctorExtension({ name: "test-h3", rulePacks: [h3Pack] })],
  });

test("rejects a legacy Runtime Evidence activation from an untyped extension", async () => {
  const pack = {
    ...h3Pack,
    activation: { runtimeEvidence: (evidence: object) => "acme" in evidence },
  };
  await withFixture({ "package.json": "{}" }, async (root) => {
    await expect(
      runDoctor({
        root,
        cache: false,
        extensions: [
          { name: "legacy", setup: (api) => api.registerRulePack(pack as typeof h3Pack) },
        ],
      }),
    ).rejects.toThrow(/activation\.runtimeEvidence.*Project Inventory/);
  });
});

test("an h3-only package activates the h3 Rule Pack and its v2 Rules", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ dependencies: { h3: "^2.0.1-rc.26", srvx: "^0.9.0" } }),
      "node_modules/h3/package.json": manifest("h3", "2.0.1-rc.26"),
      "server.ts": "export const app = 1\n",
    },
    async (root) => {
      const result = await runH3Doctor(root);

      expect(result.framework).toBe("vite");
      expect(reported(result, root)).toEqual(["server.ts"]);
      expect(activatedBy(result)).toEqual(["."]);
      expect(result.workspacePackages?.[0]?.runtimes).toEqual({
        h3: { state: "resolved", version: "2.0.1-rc.26", owner: "project" },
      });
      expect(result.diagnostics.some((item) => item.code === "DOC0022")).toBe(false);
    },
  );
});

test("only the workspace package that declares h3 activates the h3 Rule Pack", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ private: true, workspaces: ["packages/*"] }),
      "packages/web/package.json": JSON.stringify({ name: "web", dependencies: { vue: "3.5.35" } }),
      "packages/web/src/main.ts": "export const web = 1\n",
      "packages/api/package.json": JSON.stringify({
        name: "api",
        devDependencies: { h3: "^2.0.0" },
      }),
      "packages/api/node_modules/h3/package.json": manifest("h3", "2.0.1-rc.26"),
      "packages/api/src/server.ts": "export const api = 1\n",
      "node_modules/vue/package.json": manifest("vue", "3.5.35"),
    },
    async (root) => {
      const result = await runH3Doctor(root);

      expect(activatedBy(result)).toEqual(["packages/api"]);
      expect(reported(result, root)).toEqual(["packages/api/src/server.ts"]);
      const packages = Object.fromEntries(
        (result.workspacePackages ?? []).map((item) => [item.root, item]),
      );
      expect(packages["packages/api"]).toMatchObject({
        rulePacks: ["test-h3"],
        runtimes: { h3: { state: "resolved", version: "2.0.1-rc.26", owner: "project" } },
      });
      expect(packages["packages/web"]?.rulePacks).toEqual([]);
      expect(packages["packages/web"]?.runtimes?.h3).toBeUndefined();
    },
  );
});

test("each workspace package's own h3 version gates the Rules for its files", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ private: true, workspaces: ["packages/*"] }),
      "packages/api/package.json": JSON.stringify({ name: "api", dependencies: { h3: "^2.0.0" } }),
      "packages/api/node_modules/h3/package.json": manifest("h3", "2.0.1-rc.26"),
      "packages/api/src/server.ts": "export const api = 1\n",
      "packages/legacy/package.json": JSON.stringify({
        name: "legacy",
        dependencies: { h3: "^1.15.0" },
      }),
      "packages/legacy/node_modules/h3/package.json": manifest("h3", "1.15.11"),
      "packages/legacy/src/server.ts": "export const legacy = 1\n",
    },
    async (root) => {
      const result = await runH3Doctor(root);

      expect(activatedBy(result)).toEqual(["packages/api", "packages/legacy"]);
      expect(reported(result, root)).toEqual(["packages/api/src/server.ts"]);
    },
  );
});

test("a Nitro package activates the h3 Rule Pack through the h3 Nitro provides", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ dependencies: { nitro: "3.0.260610-beta" } }),
      "node_modules/nitro/package.json": manifest("nitro", "3.0.260610-beta", {
        h3: "2.0.1-rc.26",
      }),
      "node_modules/nitro/node_modules/h3/package.json": manifest("h3", "2.0.1-rc.26"),
      "server/api/hello.ts": "export default 1\n",
    },
    async (root) => {
      const result = await runH3Doctor(root);

      expect(result.framework).toBe("nitro");
      expect(activatedBy(result)).toEqual(["."]);
      expect(reported(result, root)).toEqual(["server/api/hello.ts"]);
      expect(result.workspacePackages?.[0]?.runtimes?.h3).toEqual({
        state: "resolved",
        version: "2.0.1-rc.26",
        owner: "nitro",
      });
    },
  );
});

test("a declared h3 that is not installed activates the Rule Pack but gates nothing in", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ dependencies: { h3: "^2.0.0" } }),
      "server.ts": "export const app = 1\n",
    },
    async (root) => {
      const result = await withoutNodePath(() => runH3Doctor(root));

      expect(activatedBy(result)).toEqual(["."]);
      expect(reported(result, root)).toEqual([]);
      expect(result.workspacePackages?.[0]?.runtimes).toEqual({
        h3: { state: "unknown", owner: "project" },
      });
      const unresolved = result.diagnostics.filter((item) => item.code === "DOC0022");
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]).toMatchObject({
        ruleId: "doctor/inventory/unresolved-runtime",
        file: join(root, "package.json"),
      });
      expect(unresolved[0]?.why).toContain("project -> h3");
    },
  );
});

test("a workspace package whose declared h3 is not installed reports its own unresolved runtime", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ private: true, workspaces: ["packages/*"] }),
      "packages/web/package.json": JSON.stringify({ name: "web", dependencies: { vue: "3.5.35" } }),
      "packages/api/package.json": JSON.stringify({ name: "api", dependencies: { h3: "^2.0.0" } }),
      "packages/api/src/server.ts": "export const api = 1\n",
      "node_modules/vue/package.json": manifest("vue", "3.5.35"),
    },
    async (root) => {
      const result = await withoutNodePath(() => runH3Doctor(root));

      expect(activatedBy(result)).toEqual(["packages/api"]);
      expect(reported(result, root)).toEqual([]);
      const unresolved = result.diagnostics.filter((item) => item.code === "DOC0022");
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]?.file).toBe(join(root, "packages/api/package.json"));
      expect(unresolved[0]?.why).toContain("of packages/api");
    },
  );
});

test("an h3 1.x package activates the Rule Pack while the v2 gate excludes its Rules", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ dependencies: { h3: "^1.15.0" } }),
      "node_modules/h3/package.json": manifest("h3", "1.15.11"),
      "server.ts": "export const app = 1\n",
    },
    async (root) => {
      const result = await runH3Doctor(root);

      expect(activatedBy(result)).toEqual(["."]);
      expect(reported(result, root)).toEqual([]);
      expect(result.workspacePackages?.[0]?.runtimes?.h3).toMatchObject({
        version: "1.15.11",
        owner: "project",
      });
    },
  );
});

test("a package without h3 or a framework that provides it does not activate the Rule Pack", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ dependencies: { vue: "3.5.35" } }),
      "node_modules/vue/package.json": manifest("vue", "3.5.35"),
      "src/main.ts": "export const app = 1\n",
    },
    async (root) => {
      const result = await runH3Doctor(root);

      expect(result.workspacePackages?.[0]?.rulePacks).not.toContain("test-h3");
      expect(reported(result, root)).toEqual([]);
    },
  );
});

test("an optional h3 peer or optional dependency counts only when it is installed", async () => {
  for (const declaration of [
    {
      peerDependencies: { h3: "^2.0.0" },
      peerDependenciesMeta: { h3: { optional: true } },
    },
    { optionalDependencies: { h3: "^2.0.0" } },
  ]) {
    await withFixture(
      {
        "package.json": JSON.stringify({ name: "lib", ...declaration }),
        "src/index.ts": "export const lib = 1\n",
      },
      async (root) => {
        const result = await withoutNodePath(() => runH3Doctor(root));

        expect(activatedBy(result) ?? []).toEqual([]);
        expect(result.diagnostics.filter((item) => item.code === "DOC0022")).toEqual([]);
        expect(result.workspacePackages?.[0]?.runtimes?.h3).toBeUndefined();
      },
    );
    await withFixture(
      {
        "package.json": JSON.stringify({ name: "lib", ...declaration }),
        "node_modules/h3/package.json": manifest("h3", "2.0.8"),
        "src/index.ts": "export const lib = 1\n",
      },
      async (root) => {
        const result = await withoutNodePath(() => runH3Doctor(root));

        expect(activatedBy(result)).toEqual(["."]);
        expect(reported(result, root)).toEqual(["src/index.ts"]);
      },
    );
  }
});

test("a required h3 peer counts even when it is not installed", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ name: "lib", peerDependencies: { h3: "^2.0.0" } }),
      "src/index.ts": "export const lib = 1\n",
    },
    async (root) => {
      const result = await withoutNodePath(() => runH3Doctor(root));

      expect(activatedBy(result)).toEqual(["."]);
      expect(result.diagnostics.filter((item) => item.code === "DOC0022")).toHaveLength(1);
    },
  );
});

function reported(result: DoctorRunResult, root: string): string[] {
  return result.diagnostics
    .filter((item) => item.ruleId === h3v2Rule.meta.id)
    .map((item) => item.file.slice(root.length + 1))
    .sort();
}

function activatedBy(result: DoctorRunResult): string[] | undefined {
  return result.rulePacks?.find((pack) => pack.name === "test-h3")?.activatedBy;
}

function manifest(name: string, version: string, dependencies?: Record<string, string>) {
  return JSON.stringify({ name, version, dependencies });
}

/** pnpm points NODE_PATH at its hoisted store, where h3 would resolve for a fixture that lacks it. */
async function withoutNodePath<T>(run: () => Promise<T>): Promise<T> {
  const saved = process.env.NODE_PATH;
  const initPaths = () => (Module as unknown as { _initPaths(): void })._initPaths();
  delete process.env.NODE_PATH;
  initPaths();
  try {
    return await run();
  } finally {
    if (saved !== undefined) process.env.NODE_PATH = saved;
    initPaths();
  }
}

async function withFixture(files: Record<string, string>, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "vite-doctor-runtime-activation-"));
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
