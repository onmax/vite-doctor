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
  "src/router.ts":
    'import { createRouter as makeRouter, createMemoryHistory } from "vue-router";\nimport Page /* home */ from "./Page.vue";\nexport const router = makeRouter({ history: createMemoryHistory(), routes: [{ path: "/", component: Page }] });\n',
  "src/Page.vue": page,
};

async function run(files: Record<string, string>) {
  const result = await runProjectFixture({
    framework: "vue",
    rules: [noCircularImportAtHmrBoundary],
    files,
  });
  return result.diagnostics
    .filter((item) => item.ruleId === ruleId)
    .map((item) => ({
      code: item.code,
      severity: item.severity,
      file: relative(result.project.root, item.file),
      line: item.range?.line,
      message: item.message,
      fix: JSON.stringify(item.suggestion),
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
  expect(diagnostics[0]!.fix).toContain("component: () => import('./Page.vue')");
});

test.each([
  [
    "a non-route component registry",
    'import { h } from "vue";\nimport Page from "./Page.vue";\nconst dialog = { component: Page };\nexport const router = { push: () => h(dialog.component) };',
  ],
  [
    "a shadowed component binding",
    'import { createRouter, createMemoryHistory } from "vue-router";\nimport Page from "./Page.vue";\nfunction makeRouter(Page: object) { return createRouter({ history: createMemoryHistory(), routes: [{ path: "/", component: Page }] }); }\nexport const router = makeRouter({ render: () => Page });',
  ],
  [
    "a shadowed createRouter binding",
    'import { createRouter } from "vue-router";\nimport Page from "./Page.vue";\nfunction makeRouter(createRouter: (options: object) => object) { return createRouter({ routes: [{ path: "/", component: Page }] }); }\nexport const router = makeRouter((options) => options);',
  ],
  [
    "a component also used outside the route",
    'import { createRouter, createMemoryHistory } from "vue-router";\nimport Page from "./Page.vue";\nexport const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/", component: Page }] });\nexport const dialog = { component: Page };',
  ],
])("uses generic advice for %s", async (_name, router) => {
  const diagnostics = await run({ ...app, "src/router.ts": router });
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]!.fix).not.toContain("component: () => import");
  expect(diagnostics[0]!.fix).toContain("move what src/router.ts needs");
});

test("reports a cycle through a module that calls import.meta.hot.accept", async () => {
  const diagnostics = await run({
    "src/store.ts": 'import { render } from "./view";\nexport const state = { render };\n',
    "src/view.ts":
      'import { state } from "./store";\nexport const render = () => state;\nif (import.meta.hot) import.meta.hot.accept();\n',
  });
  expect(diagnostics).toMatchObject([{ file: "src/store.ts", line: 1 }]);
});

test("a lazy route component breaks the cycle", async () => {
  expect(
    await run({
      ...app,
      "src/router.ts":
        'import { createRouter, createMemoryHistory } from "vue-router";\nexport const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/", component: () => import("./Page.vue") }] });\n',
    }),
  ).toEqual([]);
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

async function runNuxt(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "doctor-hmr-cycle-nuxt-"));
  try {
    const fixture: Record<string, string> = {
      "package.json": JSON.stringify({ type: "module", dependencies: { nuxt: "4.4.6" } }),
      ".nuxt/doctor.manifest.json": JSON.stringify({
        nuxtVersion: "4.4.6",
        vueVersion: "3.5",
        rootDir: root,
        srcDir: join(root, "app"),
        appDir: join(root, "app"),
        buildDir: join(root, ".nuxt"),
        generatedAt: new Date(Date.now() + 1000).toISOString(),
        autoImportEnabled: true,
        autoImports: [
          { name: "useCart", from: join(root, "app/composables/useCart.ts"), kind: "app" },
        ],
        components: [],
        layers: [{ root, priority: 0 }],
        routeRules: {},
        serverHandlers: [],
        modules: [],
        moduleSources: [],
      }),
      ...files,
    };
    for (const [file, text] of Object.entries(fixture)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    const result = await runViteDoctor({
      root,
      framework: "nuxt",
      cache: false,
      extends: ["auto", "vite/strict"],
      rules: ruleId,
    });
    return result.diagnostics
      .filter((item) => item.ruleId === ruleId)
      .map((item) => ({
        file: relative(root, item.file),
        message: item.message,
        fix: JSON.stringify(item.suggestion),
        related: item.related?.map((entry) => ({
          file: relative(root, entry.file),
          message: entry.message,
        })),
      }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("describes a Nuxt auto-import edge as one, and never lazy-loads an identifier", async () => {
  const diagnostics = await runNuxt({
    "app/pages/cart.vue":
      '<script setup lang="ts">\nconst cart = useCart();\n</script>\n\n<template><p>{{ cart }}</p></template>\n',
    "app/composables/useCart.ts":
      'import CartPage from "../pages/cart.vue";\nexport function useCart() {\n  return { page: CartPage };\n}\n',
  });
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    file: "app/composables/useCart.ts",
    related: [
      {
        file: "app/composables/useCart.ts",
        message: "imports '../pages/cart.vue' → app/pages/cart.vue",
      },
      {
        file: "app/pages/cart.vue",
        message: "uses auto-imported `useCart` → app/composables/useCart.ts",
      },
    ],
  });
  expect(diagnostics[0]!.message).toContain("Nuxt compiles to static imports");
  expect(diagnostics[0]!.fix).not.toContain("import('");
  expect(diagnostics[0]!.fix).toContain("into a module that neither side depends on");
});

test("deferring an early auto-import read does not break the cycle", async () => {
  const diagnostics = await runNuxt({
    "app/composables/useCart.ts":
      'import { total } from "../utils/total";\nexport const useCart = () => ({ total });\nif (import.meta.hot) import.meta.hot.accept();\n',
    "app/utils/total.ts":
      "function readCart() { return useCart(); }\nexport const total = readCart();\n",
  });
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    file: "app/utils/total.ts",
    related: [
      {
        file: "app/utils/total.ts",
        message: "uses auto-imported `useCart` → app/composables/useCart.ts",
      },
      {
        file: "app/composables/useCart.ts",
        message: "imports '../utils/total' → app/utils/total.ts",
      },
    ],
  });
  expect(diagnostics[0]!.fix).not.toContain("import('use");
  expect(diagnostics[0]!.fix).toContain("uses auto-imported `useCart`");
  expect(diagnostics[0]!.fix).toContain("until after module initialization");
  expect(diagnostics[0]!.fix).toContain("does not break the cycle or guarantee HMR succeeds");
});
