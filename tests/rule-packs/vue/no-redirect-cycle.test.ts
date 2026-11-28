import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildNuxt, loadNuxt, updateTemplates } from "nuxt/kit";
import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { runViteDoctor } from "../../../src/doctor.ts";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { sha256 } from "../../../src/core/internal/utils.ts";
import nuxtDoctorModule from "../../../src/rule-packs/nuxt/module.ts";
import { vueRulePack } from "../../../src/rule-packs/vue/index.ts";
import { noRedirectCycle } from "../../../src/rule-packs/vue/rules/vue/no-redirect-cycle.ts";

const RULE_ID = "vue/router/no-redirect-cycle";

function routerFile(
  routes: string,
  imports = "import { createRouter, createWebHistory } from 'vue-router'",
) {
  return `${imports}
import Home from './Home.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: ${routes},
})
`;
}

function runRouter(source: string) {
  return runRuleFixture({ rule: noRedirectCycle, files: { "src/router.ts": source } });
}

const relativeTo = (root: string, file: string) => file.slice(root.length + 1);

test("VUE0053 is recommended", () => {
  expect(vueRulePack.presets.recommended).toContain(RULE_ID);
});

test("reports two route records that redirect to each other", async () => {
  const result = await runRouter(
    routerFile(`[
    { path: '/', component: Home },
    { path: '/a', redirect: '/b' },
    { path: '/b', redirect: { path: '/a' } },
  ]`),
  );

  expect(result.diagnostics).toHaveLength(1);
  const [diagnostic] = result.diagnostics;
  expect(diagnostic?.code).toBe("VUE0053");
  expect(diagnostic?.severity).toBe("error");
  expect(relativeTo(result.root, diagnostic!.file)).toBe("src/router.ts");
  expect(diagnostic?.range?.line).toBe(8);
  expect(diagnostic?.why).toContain("'/a' → '/b' → '/a'");
  expect(diagnostic?.related?.map((entry) => [entry.range?.line, entry.message])).toEqual([
    [8, "'/a' redirects to '/b'."],
    [9, "'/b' redirects to '/a'."],
  ]);
});

test("reports a record that redirects to itself", async () => {
  const result = await runRouter(routerFile(`[{ path: '/a', redirect: '/a' }]`));

  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["VUE0053"]);
  expect(result.diagnostics[0]?.related).toHaveLength(1);
});

test("follows named redirects and nested child paths", async () => {
  const result = await runRouter(
    routerFile(`[
    {
      path: '/settings',
      component: Home,
      children: [
        { path: 'profile', name: 'profile', redirect: { name: 'account' } },
        { path: 'account', name: 'account', redirect: '/settings/profile' },
      ],
    },
  ]`),
  );

  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["VUE0053"]);
  expect(result.diagnostics[0]?.why).toContain("'/settings/profile' → '/settings/account'");
});

test("reads routes from a const in the same file", async () => {
  const result = await runRouter(`import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  { path: '/old', redirect: '/new' },
  { path: '/new', redirect: '/old' },
] as const

export default createRouter({ history: createWebHistory(), routes })
`);

  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["VUE0053"]);
});

test.each([
  [
    "a named target requiring params",
    `[{ path: '/a', redirect: { name: 'b' } }, { path: '/b/:id', name: 'b', redirect: '/a' }]`,
  ],
  [
    "a record removed by a duplicate name",
    `[{ path: '/a', name: 'entry', redirect: '/b' }, { path: '/b', redirect: '/a' }, { path: '/landing', name: 'entry', component: Home }]`,
  ],
  [
    "a chain that ends at a component",
    `[{ path: '/a', redirect: '/b' }, { path: '/b', redirect: '/c' }, { path: '/c', component: Home }]`,
  ],
  ["a function redirect", `[{ path: '/a', redirect: () => '/b' }, { path: '/b', redirect: '/a' }]`],
  [
    "routes Doctor cannot see",
    `[...legacyRoutes, { path: '/a', redirect: '/b' }, { path: '/b', redirect: '/a' }]`,
  ],
  [
    "a target that only a dynamic record matches",
    `[{ path: '/a', redirect: '/b' }, { path: '/:slug', redirect: '/a' }]`,
  ],
  [
    "a target that two records match",
    `[{ path: '/a', redirect: '/b' }, { path: '/b', redirect: '/a' }, { path: '/B', component: Home }]`,
  ],
  ["an alias", `[{ path: '/a', redirect: '/b' }, { path: '/b', alias: '/c', redirect: '/a' }]`],
  ["a relative redirect", `[{ path: '/a', redirect: 'b' }, { path: '/b', redirect: '/a' }]`],
  ["a dynamic path", `[{ path: base, redirect: '/b' }, { path: '/b', redirect: '/a' }]`],
])("does not report %s", async (_name, routes) => {
  const result = await runRouter(routerFile(routes));

  expect(result.diagnostics).toEqual([]);
});

test.each(["...overrides", "routes: []", "[key]: []"])(
  "does not report a routes array followed by %s",
  async (override) => {
    const source = routerFile(`[{ path: '/a', redirect: '/a' }], ${override}`);

    expect((await runRouter(source)).diagnostics).toEqual([]);
  },
);

test("does not report a createRouter that is not vue-router's", async () => {
  const result = await runRouter(
    routerFile(
      `[{ path: '/a', redirect: '/b' }, { path: '/b', redirect: '/a' }]`,
      "import { createRouter, createWebHistory } from './my-router'",
    ),
  );

  expect(result.diagnostics).toEqual([]);
});

const nuxtPage = (redirect: string) =>
  `<script setup lang="ts">\ndefinePageMeta({ redirect: '${redirect}' })\n</script>\n`;
const indexPage = "<template><main /></template>\n";

function nuxtManifest(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    generatedAt: "2100-01-01T00:00:00.000Z",
    appDir: "app",
    routerOptionsFiles: [],
    routes: [
      { path: "/", file: "app/pages/index.vue", sourceHash: sha256(indexPage) },
      { path: "/a", file: "app/pages/a.vue", redirect: "/b", sourceHash: sha256(nuxtPage("/b")) },
      { path: "/b", file: "app/pages/b.vue", redirect: "/a", sourceHash: sha256(nuxtPage("/a")) },
    ],
    ...overrides,
  });
}

function runNuxt(files: Record<string, string> = {}, manifest = nuxtManifest()) {
  return runRuleFixture({
    framework: "nuxt",
    rule: noRedirectCycle,
    files: {
      "app/pages/index.vue": indexPage,
      "app/pages/a.vue": nuxtPage("/b"),
      "app/pages/b.vue": nuxtPage("/a"),
      ".nuxt/doctor.manifest.json": manifest,
      ...files,
    },
  });
}

test("reports Nuxt pages whose resolved routes redirect to each other", async () => {
  const result = await runNuxt();

  expect(result.diagnostics).toHaveLength(1);
  const [diagnostic] = result.diagnostics;
  expect(diagnostic?.code).toBe("VUE0053");
  expect(diagnostic?.confidence).toBe("manifest-backed");
  expect(relativeTo(result.root, diagnostic!.file)).toBe("app/pages/a.vue");
  expect(diagnostic?.range?.line).toBe(2);
  expect(
    diagnostic?.related?.map((entry) => [relativeTo(result.root, entry.file), entry.message]),
  ).toEqual([
    ["app/pages/a.vue", "'/a' redirects to '/b'."],
    ["app/pages/b.vue", "'/b' redirects to '/a'."],
  ]);
});

test("reports Nuxt cycles with a statically known non-overriding options export", async () => {
  const result = await runNuxt(
    {
      "app/router.options.ts":
        "var options = { scrollBehavior() {} }; export { options as default }",
    },
    nuxtManifest({ routerOptionsFiles: ["app/router.options.ts"] }),
  );

  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["VUE0053"]);
});

test.each([
  ["an edited non-anchor page", { "app/pages/b.vue": nuxtPage("/home") }, nuxtManifest()],
  [
    "a re-exported router.options override",
    {
      "app/router.options.ts": "export { default } from './custom-router'",
      "app/custom-router.ts": "export default { routes: () => [] }",
    },
    nuxtManifest({ routerOptionsFiles: ["app/router.options.ts"] }),
  ],
  [
    "a router.options file that can replace the routes",
    {
      "app/router.options.ts": "export default { routes: (routes) => routes.filter(Boolean) }\n",
    },
    nuxtManifest({ routerOptionsFiles: ["app/router.options.ts"] }),
  ],
  [
    "a stale manifest",
    { "nuxt.config.ts": "export default defineNuxtConfig({})\n" },
    nuxtManifest({ generatedAt: "2000-01-01T00:00:00.000Z" }),
  ],
  ["a manifest without resolved routes", {}, nuxtManifest({ routes: undefined })],
  [
    "a redirect Nuxt could not extract",
    {},
    nuxtManifest({
      routes: [
        { path: "/a", file: "app/pages/a.vue", dynamic: ["redirect"] },
        { path: "/b", file: "app/pages/b.vue", redirect: "/a" },
      ],
    }),
  ],
])("does not report Nuxt pages behind %s", async (_name, files, manifest) => {
  const result = await runNuxt(files, manifest);

  expect(result.diagnostics).toEqual([]);
});

test("Nuxt refreshes redirect evidence only for the matching page resolution", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-nuxt-redirect-prepare-"));
  const cwd = process.cwd();
  let nuxt: Awaited<ReturnType<typeof loadNuxt>> | undefined;
  try {
    symlinkSync(
      fileURLToPath(new URL("../../../node_modules", import.meta.url)),
      join(root, "node_modules"),
      "junction",
    );
    mkdirSync(join(root, "app/pages/settings"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { nuxt: "*" } }));
    const routerOptions = join(root, "app/router.options.ts");
    writeFileSync(routerOptions, "export default {}\n");
    writeFileSync(join(root, "app/pages/settings.vue"), "<template><NuxtPage /></template>\n");
    const profile = join(root, "app/pages/settings/profile.vue");
    const profileSource = `<script setup>definePageMeta({ redirect: { name: 'settings-account' } })</script>\n`;
    writeFileSync(profile, profileSource);
    const account = join(root, "app/pages/settings/account.vue");
    writeFileSync(account, `<script setup>definePageMeta({ redirect: () => '/' })</script>\n`);
    writeFileSync(join(root, "app/pages/a.vue"), nuxtPage("/b"));
    const nonAnchor = join(root, "app/pages/b.vue");
    writeFileSync(nonAnchor, nuxtPage("/a") + "<template><main>Before</main></template>\n");
    process.chdir(root);
    nuxt = await loadNuxt({
      cwd: root,
      dev: true,
      overrides: {
        _prepare: true,
        modules: [nuxtDoctorModule],
        experimental: { scanPageMeta: true },
        telemetry: false,
      },
    });
    await buildNuxt(nuxt);
    const manifestFile = join(root, ".nuxt/doctor.manifest.json");
    const readManifest = () => JSON.parse(readFileSync(manifestFile, "utf8"));
    const manifest = readManifest();
    expect(manifest.routerOptionsFiles).toContain(routerOptions);
    expect(manifest.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/settings/profile",
          name: "settings-profile",
          file: profile,
          sourceHash: sha256(profileSource),
          redirect: { name: "settings-account" },
        }),
        expect.objectContaining({
          path: "/settings/account",
          name: "settings-account",
          file: account,
          dynamic: ["redirect"],
        }),
      ]),
    );

    const diagnostics = async () => {
      const result = await runViteDoctor({ root, framework: "nuxt", rules: RULE_ID, cache: false });
      return result.diagnostics.map(({ code, file }) => [code, relativeTo(root, file)]);
    };
    const cycle = [["VUE0053", "app/pages/a.vue"]];
    expect(await diagnostics()).toEqual(cycle);

    let pageResolutions = 0;
    let generatedChanges = 0;
    nuxt.hook("pages:resolved", () => {
      pageResolutions++;
    });
    nuxt.hook("app:templatesGenerated", () => {
      generatedChanges++;
    });
    writeFileSync(nonAnchor, nuxtPage("/a") + "<template><main>After</main></template>\n");
    expect(await diagnostics()).toEqual([]);
    await nuxt.callHook("builder:generateApp", {});
    expect(pageResolutions).toBe(0);
    expect(await diagnostics()).toEqual([]);

    await nuxt.callHook("builder:watch", "change", "pages/b.vue");
    await nuxt.callHook("builder:generateApp", {});
    expect(pageResolutions).toBe(1);
    expect(generatedChanges).toBe(0);
    expect(await diagnostics()).toEqual(cycle);

    writeFileSync(nonAnchor, nuxtPage("/home"));
    expect(await diagnostics()).toEqual([]);
    const resolving = Promise.withResolvers<void>();
    const releaseResolution = Promise.withResolvers<void>();
    const removeHook = nuxt.hook("pages:resolved", () => {
      resolving.resolve();
      return releaseResolution.promise;
    });
    const watch = nuxt.callHook("builder:watch", "change", "pages/b.vue");
    try {
      await Promise.race([resolving.promise, watch]);
      await nuxt.runWithContext(() =>
        updateTemplates({ filter: (template) => template.filename === "imports.mjs" }),
      );
      expect(await diagnostics()).toEqual([]);
    } finally {
      removeHook();
      releaseResolution.resolve();
      await watch;
    }
    await nuxt.callHook("builder:generateApp", {});
    expect(nuxt.vfs["#build/routes.mjs"]).toContain('redirect: "/home"');
    expect(readManifest().routes).toContainEqual(
      expect.objectContaining({
        path: "/b",
        redirect: "/home",
        sourceHash: sha256(nuxtPage("/home")),
      }),
    );
    expect(await diagnostics()).toEqual([]);

    writeFileSync(account, nuxtPage("/home"));
    await nuxt.callHook("builder:watch", "change", "pages/settings/account.vue");
    await nuxt.callHook("builder:generateApp", {});
    const accountRoute = readManifest().routes.find(
      ({ file }: { file: string }) => file === account,
    );
    expect(accountRoute.redirect).toBe("/home");
    expect(accountRoute.dynamic).toBeUndefined();
  } finally {
    await nuxt?.close();
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
});
