import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { expect, test } from "vite-plus/test";
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

test("the Nuxt manifest records full route paths and static redirects", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-nuxt-routes-manifest-"));
  try {
    mkdirSync(join(root, "app"), { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");
    const hooks = new Map<string, Array<(...payload: any[]) => unknown>>();
    const nuxt = {
      _version: "4.5.2",
      options: {
        rootDir: root,
        srcDir: join(root, "app"),
        buildDir: ".nuxt",
        modules: [],
        experimental: { scanPageMeta: true },
      },
      hook(name: string, callback: (...payload: any[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), callback]);
      },
      async callHook(name: string, ...payload: unknown[]) {
        for (const hook of hooks.get(name) ?? []) await hook(...payload);
      },
    };
    await nuxtDoctorModule({}, nuxt as any);
    await nuxt.callHook("pages:routerOptions", {
      files: [{ path: join(root, "app/router.options.ts") }],
    });
    const profile = join(root, "app/pages/settings/profile.vue");
    const profileSource = `<script setup>definePageMeta({ redirect: { name: 'settings-account' } })</script>`;
    mkdirSync(join(root, "app/pages/settings"), { recursive: true });
    writeFileSync(profile, profileSource);
    await nuxt.callHook("app:templates", {
      middleware: [],
      pages: [
        {
          path: "/settings",
          file: join(root, "app/pages/settings.vue"),
          children: [
            {
              path: "profile",
              name: "settings-profile",
              file: profile,
              redirect: { name: "settings-account" },
            },
            {
              path: "account",
              name: "settings-account",
              file: join(root, "app/pages/settings/account.vue"),
              meta: { __nuxt_dynamic_meta_key: new Set(["redirect"]) },
            },
          ],
        },
      ],
    });
    await nuxt.callHook("close", nuxt);

    const written = JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8"));
    expect(written.routerOptionsFiles).toEqual([join(root, "app/router.options.ts")]);
    expect(written.routes).toEqual([
      { path: "/settings", file: join(root, "app/pages/settings.vue") },
      {
        path: "/settings/profile",
        name: "settings-profile",
        file: profile,
        sourceHash: sha256(profileSource),
        redirect: { name: "settings-account" },
      },
      {
        path: "/settings/account",
        name: "settings-account",
        file: join(root, "app/pages/settings/account.vue"),
        dynamic: ["redirect"],
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
