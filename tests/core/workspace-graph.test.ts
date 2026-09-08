import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vite-plus/test";
import { runViteDoctor } from "../../src/doctor.ts";

test.each(["src/main.ts", "src/main.js", "app.vue"])(
  "keeps lazy-loaded modules reachable from %s",
  async (entry) => {
    await withProject(
      {
        [entry]: entry.endsWith(".vue")
          ? '<script setup>void import("./src/lazy.ts")</script>'
          : 'void import("./lazy.ts")',
        "src/lazy.ts": 'import "./effect.ts"; export default 1',
        "src/effect.ts": 'console.log("loaded")',
        "src/unused.ts": 'console.log("unused")',
      },
      async (root) => {
        const result = await runViteDoctor({ root, analyses: "dead-code", cache: false });
        expect(
          result.diagnostics
            .filter((item) => item.ruleId === "workspace/dead-code/unused-file")
            .map((item) => item.file),
        ).toEqual([join(root, "src/unused.ts")]);
      },
    );
  },
);

test("follows named and star re-exports from a package entrypoint", async () => {
  await withProject(
    {
      "src/index.ts": 'export * from "./barrel.ts"',
      "src/barrel.ts": 'export { value } from "./value.ts"',
      "src/value.ts": "export const value = 1",
    },
    async (root) => {
      const result = await runViteDoctor({ root, analyses: "dead-code", cache: false });
      expect(
        result.diagnostics.filter((item) => item.ruleId === "workspace/dead-code/unused-file"),
      ).toEqual([]);
    },
  );
});

test("counts dynamic imports and re-exports when diagnosing dependencies", async () => {
  await withProject(
    {
      "package.json": JSON.stringify({
        dependencies: { "lazy-package": "1.0.0", "exported-package": "1.0.0" },
      }),
      "src/index.ts":
        'void import("lazy-package"); export * from "exported-package"; void import("missing-package")',
    },
    async (root) => {
      const result = await runViteDoctor({ root, analyses: "dead-code", cache: false });
      expect(
        result.diagnostics.filter(
          (item) => item.ruleId === "workspace/dead-code/unused-dependency",
        ),
      ).toEqual([]);
      expect(
        result.diagnostics
          .filter((item) => item.ruleId === "workspace/dead-code/unlisted-dependency")
          .map((item) => item.message),
      ).toEqual([
        'Package "missing-package" is imported but is not listed in package.json dependencies.',
      ]);
    },
  );
});

test.each(['void import("./missing.ts")', 'export * from "./missing.ts"'])(
  "reports a missing dependency for %s without guessing expressions",
  async (statement) => {
    await withProject(
      { "src/main.ts": `${statement};\nconst target = "./optional.ts";\nvoid import(target)` },
      async (root) => {
        const result = await runViteDoctor({ root, analyses: "dead-code", cache: false });
        expect(
          result.diagnostics
            .filter((item) => item.ruleId === "workspace/dead-code/unresolved-import")
            .map((item) => item.message),
        ).toEqual(['Import "./missing.ts" could not be resolved.']);
      },
    );
  },
);

test("finds cycles through re-exports", async () => {
  await withProject(
    {
      "src/index.ts": 'export * from "./cycle.ts"',
      "src/cycle.ts": 'import "./index.ts"',
    },
    async (root) => {
      const result = await runViteDoctor({ root, analyses: "graph", cache: false });
      expect(
        result.diagnostics.filter(
          (item) => item.ruleId === "workspace/dead-code/circular-dependency",
        ),
      ).toHaveLength(1);
    },
  );
});

test("does not turn lazy loading into a static dependency cycle", async () => {
  await withProject(
    {
      "src/index.ts": 'export const load = () => import("./lazy.ts")',
      "src/lazy.ts": 'import "./index.ts"',
    },
    async (root) => {
      const result = await runViteDoctor({ root, analyses: "graph", cache: false });
      expect(
        result.diagnostics.filter(
          (item) => item.ruleId === "workspace/dead-code/circular-dependency",
        ),
      ).toEqual([]);
    },
  );
});

async function withProject(files: Record<string, string>, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "vite-doctor-workspace-graph-"));
  try {
    for (const [file, contents] of Object.entries({ "package.json": "{}", ...files })) {
      const target = join(root, file);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
