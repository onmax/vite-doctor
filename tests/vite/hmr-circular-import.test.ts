import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "pathe";
import { expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../src/core/testkit.ts";
import { runViteDoctor } from "../../src/doctor.ts";
import { noCircularImportAtHmrBoundary, viteRulePack } from "../../src/rules.ts";

const ruleId = "vite/hmr/no-circular-import-at-hmr-boundary";

const page = `<script setup lang="ts">
import { router } from "./router";
const go = () => router.push("/");
</script>

<template><button @click="go">Home</button></template>
`;

const app = {
  "src/main.ts": 'import { router } from "./router";\nrouter.start();\n',
  "src/router.ts":
    'export const before = 1;\nimport Page from "./Page.vue";\nexport const router = { routes: [{ path: "/", component: Page }], push(path: string) {}, start() {} };\n',
  "src/Page.vue": page,
};

async function run(files: Record<string, string>, resolvedHmr?: boolean) {
  const result = await runProjectFixture({
    framework: "vue",
    rules: [noCircularImportAtHmrBoundary],
    files,
    extensions:
      resolvedHmr === undefined
        ? []
        : [
            {
              name: "fixture/vite-dev-config",
              setup(api) {
                api.registerRuntimeEvidenceContributor({
                  name: "vite",
                  contribute: ({ root }) => ({ clientHmr: { root, enabled: resolvedHmr } }),
                });
              },
            },
          ],
  });
  return result.diagnostics
    .filter((item) => item.ruleId === ruleId)
    .map((item) => ({
      code: item.code,
      severity: item.severity,
      file: relative(result.project.root, item.file),
      line: item.range?.line,
      message: item.message,
      fix: item.diagnostic.fix,
      evidence: item.evidence?.map((entry) => entry.summary),
      related: item.related?.map((entry) => ({
        file: relative(result.project.root, entry.file),
        line: entry.range?.line,
        message: entry.message,
      })),
    }));
}

test("reports a static cycle through a Vue SFC at the import into the SFC", async () => {
  const diagnostics = await run(app);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    code: "VITE0029",
    severity: "info",
    file: "src/router.ts",
    line: 2,
    related: [
      { file: "src/router.ts", line: 2, message: "imports './Page.vue' → src/Page.vue" },
      { file: "src/Page.vue", line: 2, message: "imports './router' → src/router.ts" },
    ],
  });
  expect(diagnostics[0]!.message).toContain("src/router.ts → src/Page.vue → src/router.ts");
  expect(diagnostics[0]!.message).toContain("reloads the whole page");
});

test("reports a cycle through a module that calls import.meta.hot.accept", async () => {
  const diagnostics = await run({
    "src/store.ts": 'import { render } from "./view";\nexport const state = { render };\n',
    "src/view.ts":
      'import { state } from "./store";\nexport const render = () => state;\nif (import.meta.hot) import.meta.hot.accept();\n',
  });
  expect(diagnostics).toMatchObject([{ file: "src/store.ts", line: 1 }]);
});

test("a lazy route component still forms a cycle in Vite's HMR importer graph", async () => {
  const diagnostics = await run({
    ...app,
    "src/router.ts":
      'export const router = { routes: [{ path: "/", component: () => import("./Page.vue") }], push(path: string) {}, start() {} };\n',
  });
  expect(diagnostics).toMatchObject([
    {
      code: "VITE0029",
      file: "src/router.ts",
      line: 1,
      related: [
        { file: "src/router.ts", line: 1, message: "lazily imports './Page.vue' → src/Page.vue" },
        { file: "src/Page.vue", line: 2, message: "imports './router' → src/router.ts" },
      ],
    },
  ]);
  expect(diagnostics[0]!.fix).toContain("src/Page.vue:2 imports './router'");
  expect(diagnostics[0]!.fix).not.toContain("component: () => import");
});

const plainCycle = {
  "src/a.js": 'import { b } from "./b.js";\nexport const a = () => b;\n',
  "src/b.js": 'import { a } from "./a.js";\nexport const b = () => a;\n',
};

test("import.meta.hot.accept in a comment or string is not an HMR boundary", async () => {
  expect(
    await run({
      ...plainCycle,
      "src/b.js": `${plainCycle["src/b.js"]}// import.meta.hot.accept()\nexport const note = "import.meta.hot.accept()";\n`,
    }),
  ).toEqual([]);
});

test("accepting a dependency does not make the module a self-accepting boundary", async () => {
  expect(
    await run({
      ...plainCycle,
      "src/other.js": "export const other = 1;\n",
      "src/b.js": `${plainCycle["src/b.js"]}import "./other.js";\nif (import.meta.hot) import.meta.hot.accept("./other.js", () => {});\n`,
    }),
  ).toEqual([]);
});

test("a callback-only accept call makes the module a boundary", async () => {
  expect(
    await run({
      ...plainCycle,
      "src/b.js": `${plainCycle["src/b.js"]}import.meta.hot?.accept((mod) => {});\n`,
    }),
  ).toMatchObject([{ file: "src/a.js", line: 1 }]);
});

test("Vue SFCs are not boundaries when the Vite config sets server.hmr to false", async () => {
  expect(
    await run({
      ...app,
      "vite.config.ts":
        'import vue from "@vitejs/plugin-vue";\nexport default { plugins: [vue()], server: { hmr: false } };\n',
    }),
  ).toEqual([]);
});

test("says it assumes client HMR when the Vite config does not decide it", async () => {
  const diagnostics = await run(app);
  expect(diagnostics[0]!.evidence?.[0]).toContain("server.hmr");
});

test.each<[string, Record<string, string>]>([
  [
    "build-only setting",
    {
      "vite.config.ts":
        "export default ({ command }) => command === 'serve' ? {} : { server: { hmr: false } };",
    },
  ],
  [
    "unused object",
    { "vite.config.ts": "const buildOnly = { server: { hmr: false } }; export default {};" },
  ],
  [
    "later spread",
    {
      "vite.config.ts":
        "const overrides = { hmr: true }; export default { server: { hmr: false, ...overrides } };",
    },
  ],
  [
    "computed key",
    {
      "vite.config.ts":
        "const key = 'hmr'; export default { server: { hmr: false, [key]: true } };",
    },
  ],
  [
    "shadowed config",
    {
      "vite.config.js": "export default {};",
      "vite.config.ts": "export default { server: { hmr: false } };",
    },
  ],
  ["Nuxt config", { "nuxt.config.ts": "export default { vite: { server: { hmr: false } } };" }],
])("still reports the Vue boundary: %s", async (_label, configs) => {
  const diagnostics = await run({ ...app, ...configs });
  expect(diagnostics).toMatchObject([{ code: "VITE0029" }]);
  expect(diagnostics[0]!.evidence?.[0]).toContain("assumes client HMR is on");
});

test("reads a static object wrapped in Vite's defineConfig", async () => {
  expect(
    await run({
      ...app,
      "vite.config.ts":
        'import { defineConfig as config } from "vite"; export default config({ server: { hmr: false } });',
    }),
  ).toEqual([]);
});

test("prefers resolved Vite dev evidence over the default config file", async () => {
  expect(await run(app, false)).toEqual([]);
  const diagnostics = await run(
    {
      ...app,
      "vite.config.ts": "export default { server: { hmr: false } };",
    },
    true,
  );
  expect(diagnostics).toMatchObject([{ code: "VITE0029" }]);
  expect(diagnostics[0]!.evidence?.[0]).toContain("Resolved Vite dev config");
});

test("a cycle between plain modules with no HMR boundary is left to DOC0001", async () => {
  expect(
    await run({
      "src/a.ts": 'import { b } from "./b";\nexport const a = () => b;\n',
      "src/b.ts": 'import { a } from "./a";\nexport const b = () => a;\n',
      "src/Page.vue": '<script setup lang="ts">\nimport { a } from "./a";\n</script>\n',
    }),
  ).toEqual([]);
});

test("a type-only back edge does not form a cycle", async () => {
  expect(
    await run({
      ...app,
      "src/Page.vue": page.replace(
        'import { router } from "./router";\nconst go = () => router.push("/");',
        'import type { router } from "./router";\nconst go = (r: typeof router) => r.push("/");',
      ),
    }),
  ).toEqual([]);
});

test("is Strict-only and reports nothing under the Recommended Preset", async () => {
  expect(viteRulePack.presets?.recommended).not.toContain(ruleId);
  expect(viteRulePack.presets?.strict).toContain(ruleId);
  const root = mkdtempSync(join(tmpdir(), "doctor-hmr-cycle-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ type: "module", dependencies: { vite: "^8.0.0", vue: "^3.5.0" } }),
    );
    for (const [file, text] of Object.entries(app)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    const codes = async (extend?: string[]) =>
      (await runViteDoctor({ root, framework: "vite", cache: false, extends: extend })).diagnostics
        .map((item) => item.code)
        .filter((code) => code === "VITE0029");
    expect(await codes()).toEqual([]);
    expect(await codes(["auto", "vite/strict"])).toEqual(["VITE0029"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
