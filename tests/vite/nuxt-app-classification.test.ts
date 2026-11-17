import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { afterEach, expect, test } from "vite-plus/test";
import { detectProject } from "../../src/core/index.ts";
import { runViteDoctor } from "../../src/doctor.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "doctor-nuxt-app-classification-"));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const nuxtModule = `import { defineNuxtModule } from '@nuxt/kit'
export default defineNuxtModule({ meta: { name: 'console' }, setup() {} })
`;
const useRoutePage = `<script setup lang="ts">
import { useRoute } from "vue-router";
const route = useRoute();
</script>
<template><a href="/settings">{{ route.path }}</a></template>
`;
const routerShell = "<template><RouterView /></template>\n";

// A Vite-built library that ships a Nuxt module and a vue-router SPA, next to a real Nuxt app.
function consoleMonorepo(members: Record<string, string> = {}) {
  return fixture({
    "package.json": JSON.stringify({
      name: "workspace",
      private: true,
      devDependencies: { nitro: "^3.0.0", nuxt: "^4.0.0" },
    }),
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    "packages/console/package.json": JSON.stringify({
      name: "@workspace/console",
      exports: { ".": "./dist/index.js", "./nuxt": "./dist/nuxt.js" },
      peerDependencies: { vue: "^3.5.0", nitro: "^3.0.0" },
      devDependencies: { nuxt: "^4.0.0", vue: "^3.5.0", "vue-router": "^4.5.0", nitro: "^3.0.0" },
    }),
    "packages/console/src/nuxt.ts": nuxtModule,
    "packages/console/src/client/main.ts": `import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./app.vue";
createApp(App).use(createRouter({ history: createWebHistory(), routes: [] })).mount("#app");
`,
    "packages/console/src/client/app.vue": routerShell,
    "packages/console/src/client/pages/blob.vue": useRoutePage,
    "packages/kit/package.json": JSON.stringify({
      name: "@workspace/kit",
      exports: { "./nuxt": "./dist/nuxt.js" },
      dependencies: { "@nuxt/kit": "^4.0.0" },
      devDependencies: { vue: "^3.5.0" },
    }),
    "packages/kit/src/nuxt.ts": nuxtModule,
    "packages/site/package.json": JSON.stringify({
      name: "@workspace/site",
      dependencies: { nuxt: "^4.0.0" },
    }),
    "packages/site/nuxt.config.ts": "export default defineNuxtConfig({})\n",
    "packages/site/app/app.vue": routerShell,
    "packages/site/app/pages/index.vue": useRoutePage,
    ...members,
  });
}

const routingRules = [
  "nuxt/routing/prefer-nuxt-useroute",
  "nuxt/routing/prefer-nuxtlink",
  "nuxt/routing/prefer-nuxtpage-over-routerview",
];

function routingDiagnostics(result: Awaited<ReturnType<typeof runViteDoctor>>, root: string) {
  return result.diagnostics
    .filter((diagnostic) => routingRules.includes(diagnostic.ruleId))
    .map((diagnostic) => `${diagnostic.ruleId}:${diagnostic.file.slice(root.length + 1)}`)
    .sort();
}

test("a package that ships a Nuxt module without being a Nuxt app is not a Nuxt workspace package", async () => {
  const root = consoleMonorepo();

  const project = await detectProject(root);

  expect(project.framework).toBe("nuxt");
  expect(
    project.workspacePackages?.map(({ root, framework, nuxtIntegration }) => ({
      root,
      framework,
      nuxtIntegration,
    })),
  ).toEqual([
    { root: ".", framework: "nitro", nuxtIntegration: undefined },
    { root: "packages/console", framework: "nitro", nuxtIntegration: true },
    { root: "packages/kit", framework: "vue", nuxtIntegration: true },
    { root: "packages/site", framework: "nuxt", nuxtIntegration: undefined },
  ]);
  expect(project.nuxt?.appRoots).toEqual([join(root, "packages/site")]);
  expect(project.workspaceNuxt ?? []).toEqual([]);
});

test("a Nuxt app is recognized by its app entry without a nuxt.config", async () => {
  const root = fixture({
    "package.json": JSON.stringify({ dependencies: { nuxt: "^4.0.0" } }),
    "app/pages/index.vue": useRoutePage,
  });

  expect((await detectProject(root)).workspacePackages).toEqual([
    expect.objectContaining({ root: ".", framework: "nuxt" }),
  ]);
});

test("Nuxt routing rules report Nuxt app files only, not a vue-router SPA in a Nuxt integration package", async () => {
  const root = consoleMonorepo();

  const result = await runViteDoctor({ root, cache: false, runtimeTarget: { nuxt: "4.1.0" } });

  expect(routingDiagnostics(result, root)).toEqual([
    "nuxt/routing/prefer-nuxt-useroute:packages/site/app/pages/index.vue",
    "nuxt/routing/prefer-nuxtlink:packages/site/app/pages/index.vue",
    "nuxt/routing/prefer-nuxtpage-over-routerview:packages/site/app/app.vue",
  ]);
});

test("an explicit Nuxt preset still skips files outside Nuxt apps", async () => {
  const root = consoleMonorepo();

  const result = await runViteDoctor({
    root,
    cache: false,
    extends: ["vite-doctor/nuxt/strict"],
    runtimeTarget: { nuxt: "4.1.0" },
  });

  expect(routingDiagnostics(result, root)).toEqual([
    "nuxt/routing/prefer-nuxt-useroute:packages/site/app/pages/index.vue",
    "nuxt/routing/prefer-nuxtlink:packages/site/app/pages/index.vue",
    "nuxt/routing/prefer-nuxtpage-over-routerview:packages/site/app/app.vue",
  ]);
});

test("Nuxt routing rules skip a Nuxt app package that sets up vue-router itself", async () => {
  const root = consoleMonorepo({
    "packages/site/app/legacy/main.ts": `import { createRouter, createMemoryHistory } from "vue-router";
export const router = createRouter({ history: createMemoryHistory(), routes: [] });
`,
  });

  const result = await runViteDoctor({ root, cache: false, runtimeTarget: { nuxt: "4.1.0" } });

  expect(routingDiagnostics(result, root)).toEqual([]);
});

test("NUXT0051 offers the NuxtPage rename as a suggestion, and NUXT0049 claims no edit", async () => {
  const root = consoleMonorepo();

  const result = await runViteDoctor({ root, cache: false, runtimeTarget: { nuxt: "4.1.0" } });

  const routerView = result.diagnostics.find(
    (diagnostic) => diagnostic.ruleId === "nuxt/routing/prefer-nuxtpage-over-routerview",
  );
  expect(routerView?.fix?.kind).toBe("suggestion");
  const useRoute = result.diagnostics.find(
    (diagnostic) => diagnostic.ruleId === "nuxt/routing/prefer-nuxt-useroute",
  );
  expect(useRoute?.fix).toBeUndefined();
  const { preferNuxtUseRoute, preferNuxtPageOverRouterView } =
    await import("../../src/rule-packs/nuxt/rules/nuxt/index.ts");
  expect(preferNuxtUseRoute.meta.fixable).toBe("suggestion");
  expect(preferNuxtPageOverRouterView.meta.fixable).toBe("suggestion");
});

test("Nuxt routing rules report in a Nuxt module's runtime directory", async () => {
  const root = fixture({
    "package.json": JSON.stringify({
      name: "@acme/nuxt-console",
      type: "module",
      exports: { ".": "./dist/module.mjs" },
      dependencies: { "@nuxt/kit": "^4.0.0" },
      devDependencies: { "@nuxt/module-builder": "^1.0.0", nuxt: "^4.0.0" },
    }),
    "src/module.ts": nuxtModule,
    "src/runtime/components/ConsoleShell.vue": routerShell,
  });

  const result = await runViteDoctor({ root, cache: false, runtimeTarget: { nuxt: "4.1.0" } });

  expect(routingDiagnostics(result, root)).toEqual([
    "nuxt/routing/prefer-nuxtpage-over-routerview:src/runtime/components/ConsoleShell.vue",
  ]);
});

const buttonRule = "vue/template/html-button-has-type";
const button = "<template><button>Save</button></template>\n";

test("a root dependency activates its Rule Pack for the root's own files only", async () => {
  const root = fixture({
    "package.json": JSON.stringify({ name: "workspace", devDependencies: { vue: "^3.5.0" } }),
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    "src/Save.vue": button,
    "packages/lib/package.json": JSON.stringify({ name: "@workspace/lib" }),
    "packages/lib/src/Save.vue": button,
  });

  const result = await runViteDoctor({ root, cache: false });

  expect(
    result.diagnostics
      .filter((diagnostic) => diagnostic.ruleId === buttonRule)
      .map((diagnostic) => diagnostic.file.slice(root.length + 1)),
  ).toEqual(["src/Save.vue"]);
  expect(
    result.workspacePackages?.map(({ root, rulePacks }) => ({
      root,
      vue: rulePacks.includes("vite-doctor/vue"),
    })),
  ).toEqual([
    { root: ".", vue: true },
    { root: "packages/lib", vue: false },
  ]);
});

test("a Nuxt integration package activates the Rule Packs for the Vue, Nitro and module code it ships", async () => {
  const root = consoleMonorepo();

  const result = await runViteDoctor({ root, cache: false, runtimeTarget: { nuxt: "4.1.0" } });

  const activations = new Map(
    result.workspacePackages?.map((item) => [item.root, item.rulePacks] as const),
  );
  expect(activations.get("packages/console")).toEqual(
    expect.arrayContaining(["vite-doctor/vue", "vite-doctor/nitro", "vite-doctor/nuxt"]),
  );
  expect(activations.get(".")).not.toContain("vite-doctor/nuxt");
});

test("a package that exports a Nuxt module keeps the Nitro Rule Pack for the handlers it registers", async () => {
  const root = consoleMonorepo({
    "packages/database/package.json": JSON.stringify({
      name: "@workspace/database",
      exports: { ".": "./dist/index.js", "./nuxt": "./dist/nuxt.js" },
      devDependencies: { vite: "^7.0.0" },
    }),
    "packages/database/src/nuxt.ts": `import type { Plugin } from "vite";
export function registerDatabase(config: { handlers?: unknown[] }) {
  config.handlers = [{ handler: "./runtime/middleware.ts", middleware: true }];
}
export type DatabasePlugin = Plugin;
`,
  });

  const result = await runViteDoctor({ root, cache: false, runtimeTarget: { nuxt: "4.1.0" } });

  expect(
    result.diagnostics
      .filter((diagnostic) => diagnostic.ruleId === "nitro/config/require-absolute-generated-paths")
      .map((diagnostic) => diagnostic.file.slice(root.length + 1)),
  ).toEqual(["packages/database/src/nuxt.ts"]);
  expect(result.workspacePackages?.find((item) => item.root === "packages/database")).toMatchObject(
    { framework: "vite", rulePacks: expect.arrayContaining(["vite-doctor/nitro"]) },
  );
});

for (const [path, source] of Object.entries({
  "app/utils/comment.ts": "// import { createRouter } from 'vue-router'\nexport const value = 1",
  "app/utils/string.ts": `export const text = "import { createRouter } from 'vue-router'"`,
  "app/utils/unused.ts": "import { createRouter } from 'vue-router'",
  "fixtures/main.ts": "import { createRouter } from 'vue-router'; createRouter({ routes: [] })",
})) {
  test(`router evidence ignores ${path}`, async () => {
    const root = fixture({
      "package.json": JSON.stringify({ dependencies: { nuxt: "^4" } }),
      "nuxt.config.ts": "export default defineNuxtConfig({})",
      "app/app.vue": routerShell,
      [path]: source,
    });
    const result = await runViteDoctor({ root, cache: false, rules: routingRules.join(",") });
    expect(routingDiagnostics(result, root)).toEqual([
      "nuxt/routing/prefer-nuxtpage-over-routerview:app/app.vue",
    ]);
  });
}

test("nuxt/kit modules with only a Nuxt devDependency retain module diagnostics", async () => {
  const root = fixture({
    "package.json": JSON.stringify({
      devDependencies: { nuxt: "^4" },
      exports: { ".": "./dist/module.mjs" },
    }),
    "src/module.ts":
      "import { defineNuxtModule } from 'nuxt/kit'; export default defineNuxtModule({ setup() {} })",
  });
  const result = await runViteDoctor({ root, cache: false, rules: "nuxt/module/require-meta" });
  expect(result.diagnostics.some((item) => item.ruleId === "nuxt/module/require-meta")).toBe(true);
});

test("integration-only projects execute Nuxt security rules", async () => {
  const root = fixture({
    "package.json": JSON.stringify({
      dependencies: { "@nuxt/kit": "^4" },
      exports: { ".": "./dist/index.mjs", "./nuxt": "./dist/nuxt.mjs" },
    }),
    "src/nuxt.ts": nuxtModule,
    "src/runtime/plugins/head.ts":
      "import { useHead } from '#imports'; useHead({ script: [{ innerHTML: 'alert(1)' }] })",
  });
  const rule = "nuxt/security/no-unsafe-usehead-script";
  const result = await runViteDoctor({ root, cache: false, rules: rule });
  expect(result.diagnostics.some((item) => item.ruleId === rule)).toBe(true);
});

test("explicit Vue selection applies to dependency-free workspace packages", async () => {
  const root = fixture({
    "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
    "packages/lib/package.json": JSON.stringify({ name: "lib" }),
    "packages/lib/src/Button.vue": button,
  });
  const result = await runViteDoctor({ root, framework: "vue", cache: false, rules: buttonRule });
  expect(result.diagnostics.filter((item) => item.ruleId === buttonRule)).toHaveLength(1);
});
