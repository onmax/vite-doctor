import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { relative } from "pathe";
import { expect, test } from "vite-plus/test";
import type { GraphEdge } from "../../src/core/primitives.ts";
import { parseSourceFiles } from "../../src/core/internal/facts.ts";
import { createScanSession } from "../../src/core/internal/scan-session.ts";
import {
  buildWorkspaceGraph,
  runStructuralGraphRules,
} from "../../src/core/internal/workspace-graph.ts";
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

const monorepo = {
  "package.json": JSON.stringify({ private: true, dependencies: { defu: "1.0.0" } }),
  "apps/web/nuxt.config.ts": "export default {}",
  "apps/web/app/app.vue": [
    '<script setup lang="ts">',
    'import { useThing } from "~/composables/thing"',
    'import { shared } from "@/utils/shared"',
    'import config from "~~/server/utils/config"',
    'import { handler } from "~~/server/handlers/ping"',
    'import { add } from "@acme/core"',
    'import { missing } from "~/composables/missing"',
    "useThing(shared, config, handler, add, missing)",
    "</script>",
  ].join("\n"),
  "apps/web/app/composables/thing.ts": "export function useThing(..._args: unknown[]) {}",
  "apps/web/app/utils/shared.ts": 'import { defu } from "defu"\nexport const shared = defu({}, {})',
  "apps/web/app/pages/index.vue":
    '<script setup lang="ts">import Card from "../components/Card.vue"; void Card</script>',
  "apps/web/app/components/Card.vue": "<template><div /></template>",
  "apps/web/server/utils/config.ts": "export default {}",
  "apps/web/handlers/ping.ts": "export const handler = () => 'pong'",
  "apps/web/legacy/old.ts": "export const legacyValue = 1",
  "packages/core/package.json": JSON.stringify({
    name: "@acme/core",
    exports: {
      ".": { types: "./dist/index.d.mts", import: "./dist/index.mjs" },
      "./extra": "./dist/extra.mjs",
    },
  }),
  "packages/core/src/index.ts": 'export * from "./math.js"\nexport { helper } from "./helper"',
  "packages/core/src/math.ts": 'import { helper } from "./helper"\nexport const add = helper',
  "packages/core/src/helper.ts": 'import { add } from "./math"\nexport const helper = 1; void add',
  "packages/core/src/extra.ts": "export const add = 2",
  "packages/core/src/lazy.ts": 'export const load = () => import("./math.js")',
};

test("pins the workspace graph for a monorepo with aliases and workspace packages", async () => {
  await withProject(monorepo, async (root) => {
    const session = await createScanSession({ root, cache: false, analyses: "dead-code,graph" });
    await parseSourceFiles(session);
    const graph = buildWorkspaceGraph(session);
    const name = (id: number | undefined) =>
      id === undefined ? "?" : graph.files.get(id)!.relativePath;
    const edge = (item: GraphEdge) =>
      `${name(item.from)} -[${item.kind} ${item.specifier?.replace(session.root, "<root>") ?? ""}]-> ${name(item.to)}`;

    expect(graph.importEdges.map(edge)).toMatchInlineSnapshot(`
      [
        "apps/web/app/app.vue -[import ~/composables/thing]-> apps/web/app/composables/thing.ts",
        "apps/web/app/app.vue -[import @/utils/shared]-> apps/web/app/utils/shared.ts",
        "apps/web/app/app.vue -[import ~~/server/utils/config]-> apps/web/server/utils/config.ts",
        "apps/web/app/app.vue -[import ~~/server/handlers/ping]-> apps/web/handlers/ping.ts",
        "apps/web/app/app.vue -[import @acme/core]-> ?",
        "apps/web/app/app.vue -[import ~/composables/missing]-> ?",
        "apps/web/app/pages/index.vue -[import ../components/Card.vue]-> apps/web/app/components/Card.vue",
        "apps/web/app/utils/shared.ts -[import defu]-> ?",
        "packages/core/src/helper.ts -[import ./math]-> packages/core/src/math.ts",
        "packages/core/src/lazy.ts -[dynamic-import ./math.js]-> packages/core/src/math.ts",
        "packages/core/src/math.ts -[import ./helper]-> packages/core/src/helper.ts",
        "packages/core/src/index.ts -[virtual-root package-entry:<root>/packages/core/src/index.ts]-> packages/core/src/index.ts",
        "packages/core/src/extra.ts -[virtual-root package-entry:<root>/packages/core/src/extra.ts]-> packages/core/src/extra.ts",
        "apps/web/app/app.vue -[virtual-root convention:apps/web/app/app.vue]-> apps/web/app/app.vue",
        "apps/web/app/components/Card.vue -[virtual-root convention:apps/web/app/components/Card.vue]-> apps/web/app/components/Card.vue",
        "apps/web/app/composables/thing.ts -[virtual-root convention:apps/web/app/composables/thing.ts]-> apps/web/app/composables/thing.ts",
        "apps/web/app/pages/index.vue -[virtual-root convention:apps/web/app/pages/index.vue]-> apps/web/app/pages/index.vue",
        "apps/web/server/utils/config.ts -[virtual-root convention:apps/web/server/utils/config.ts]-> apps/web/server/utils/config.ts",
        "packages/core/src/index.ts -[virtual-root convention:packages/core/src/index.ts]-> packages/core/src/index.ts",
      ]
    `);
    expect(graph.exportEdges.map(edge)).toMatchInlineSnapshot(`
      [
        "apps/web/app/composables/thing.ts -[export ]-> ?",
        "apps/web/app/utils/shared.ts -[export ]-> ?",
        "apps/web/handlers/ping.ts -[export ]-> ?",
        "apps/web/legacy/old.ts -[export ]-> ?",
        "apps/web/nuxt.config.ts -[export ]-> ?",
        "apps/web/server/utils/config.ts -[export ]-> ?",
        "packages/core/src/extra.ts -[export ]-> ?",
        "packages/core/src/helper.ts -[export ]-> ?",
        "packages/core/src/index.ts -[re-export ./math.js]-> packages/core/src/math.ts",
        "packages/core/src/index.ts -[re-export ./helper]-> packages/core/src/helper.ts",
        "packages/core/src/lazy.ts -[export ]-> ?",
        "packages/core/src/math.ts -[export ]-> ?",
      ]
    `);
    expect(
      graph.virtualRoots.map(
        (item) => `${item.kind} ${item.id.replace(session.root, "<root>")} ${name(item.fileId)}`,
      ),
    ).toMatchInlineSnapshot(`
      [
        "package package:<root>/package.json ?",
        "package package-entry:<root>/packages/core/src/index.ts packages/core/src/index.ts",
        "package package-entry:<root>/packages/core/src/extra.ts packages/core/src/extra.ts",
        "config convention:apps/web/app/app.vue apps/web/app/app.vue",
        "config convention:apps/web/app/components/Card.vue apps/web/app/components/Card.vue",
        "config convention:apps/web/app/composables/thing.ts apps/web/app/composables/thing.ts",
        "config convention:apps/web/app/pages/index.vue apps/web/app/pages/index.vue",
        "nuxt-server convention:apps/web/server/utils/config.ts apps/web/server/utils/config.ts",
        "config convention:packages/core/src/index.ts packages/core/src/index.ts",
      ]
    `);
    expect(
      [...graph.reverseIndex.importersByFile].map(
        ([file, importers]) => `${name(file)} <- ${importers.map(name).join(", ")}`,
      ),
    ).toMatchInlineSnapshot(`
      [
        "apps/web/app/composables/thing.ts <- apps/web/app/app.vue",
        "apps/web/app/utils/shared.ts <- apps/web/app/app.vue",
        "apps/web/server/utils/config.ts <- apps/web/app/app.vue",
        "apps/web/handlers/ping.ts <- apps/web/app/app.vue",
        "apps/web/app/components/Card.vue <- apps/web/app/pages/index.vue",
        "packages/core/src/math.ts <- packages/core/src/helper.ts, packages/core/src/lazy.ts, packages/core/src/index.ts",
        "packages/core/src/helper.ts <- packages/core/src/math.ts, packages/core/src/index.ts",
      ]
    `);
    expect(graph.sccs.filter((item) => item.length > 1).map((item) => item.map(name)))
      .toMatchInlineSnapshot(`
        [
          [
            "packages/core/src/math.ts",
            "packages/core/src/helper.ts",
          ],
        ]
      `);

    runStructuralGraphRules(session, graph);
    expect(
      session.diagnostics.map(
        (item) => `${item.ruleId} ${relative(session.root, item.file)} ${item.message}`,
      ),
    ).toMatchInlineSnapshot(`
      [
        "workspace/dead-code/unresolved-import apps/web/app/app.vue Import "~/composables/missing" could not be resolved.",
        "workspace/dead-code/unused-file apps/web/legacy/old.ts File is not reachable from known package, framework, or manifest roots.",
        "workspace/dead-code/unused-export apps/web/legacy/old.ts Export "legacyValue" is not referenced by known imports or framework roots.",
        "workspace/dead-code/unused-file packages/core/src/lazy.ts File is not reachable from known package, framework, or manifest roots.",
        "workspace/dead-code/unused-export packages/core/src/lazy.ts Export "load" is not referenced by known imports or framework roots.",
        "workspace/dead-code/unlisted-dependency package.json Package "@acme/core" is imported but is not listed in package.json dependencies.",
        "workspace/dead-code/circular-dependency packages/core/src/math.ts Circular dependency detected across 2 files.",
        "workspace/dead-code/duplicate-export packages/core/src/extra.ts Export name "add" appears in multiple files.",
        "workspace/dead-code/duplicate-export packages/core/src/helper.ts Export name "helper" appears in multiple files.",
      ]
    `);
  });
});

test("pins package entry roots for directory, nested, wildcard, and missing targets", async () => {
  await withProject(
    {
      "packages/odd/package.json": JSON.stringify({
        main: "./lib",
        module: "./src/entry.ts/nested.mjs",
        types: "./missing/index.d.ts",
        bin: { odd: "./bin/odd.js" },
        exports: { "./*": "./dist/*.mjs", "./dir": "./lib/", "./entry": "./dist/entry.mjs" },
      }),
      "packages/odd/lib/index.ts": "export const lib = 1",
      "packages/odd/src/entry.ts": "export const entry = 1",
      "packages/odd/bin/odd.js": "console.log('odd')",
    },
    async (root) => {
      const session = await createScanSession({ root, cache: false });
      await parseSourceFiles(session);
      const graph = buildWorkspaceGraph(session);
      expect(
        graph.virtualRoots
          .filter((item) => item.id.startsWith("package-entry:"))
          .map((item) => relative(session.root, item.file ?? "")),
      ).toMatchInlineSnapshot(`
        [
          "packages/odd/lib",
          "packages/odd/lib/index.ts",
          "packages/odd/bin/odd.js",
          "packages/odd/src/entry.ts",
        ]
      `);
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
