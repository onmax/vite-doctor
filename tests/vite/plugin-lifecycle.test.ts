import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  build,
  createBuilder,
  resolveConfig,
  type Logger,
  type Plugin,
  type ViteDevServer,
} from "vite";
import { expect, test, vi } from "vite-plus/test";
import { createRule, defineDoctorExtension, defineRulePack } from "../../src/extension.ts";
import { doctor } from "../../src/plugin.ts";

async function withProject(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "doctor-plugin-lifecycle-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(root, "entry.ts"), 'export const greeting = "hello";\n');
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function installFixtureVue(root: string) {
  await mkdir(join(root, "node_modules/vue"), { recursive: true });
  await writeFile(
    join(root, "node_modules/vue/package.json"),
    JSON.stringify({ name: "vue", version: "3.5.0", main: "index.js" }),
  );
  await writeFile(join(root, "node_modules/vue/index.js"), "module.exports = {};");
}

test("a reused Plugin Surface diagnoses each resolved Vite build", async () => {
  await withProject(async (root) => {
    const plugin = doctor({ rules: "vite/env/no-client-secret-pattern", cache: false });
    const config = {
      root,
      configFile: false as const,
      logLevel: "silent" as const,
      plugins: [plugin],
      build: {
        write: false,
        lib: { entry: join(root, "entry.ts"), formats: ["es" as const] },
      },
    };
    await build(config);
    await writeFile(
      join(root, "entry.ts"),
      "export const secret = import.meta.env.VITE_API_SECRET;\n",
    );
    await expect(build(config)).rejects.toThrow("vite/env/no-client-secret-pattern");
  });
});

test("Pinia classifies destructuring against the configured Vite alias", async () => {
  await withProject(async (root) => {
    await installFixtureVue(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ type: "module", dependencies: { pinia: "^3.0.0", vue: "^3.5.0" } }),
    );
    const store = (id: string, options: string) =>
      `import { defineStore } from 'pinia'\nexport const useCartStore = defineStore('${id}', ${options})`;
    for (const dir of ["src", "custom"])
      await mkdir(join(root, dir, "stores"), { recursive: true });
    await writeFile(
      join(root, "src/stores/cart.ts"),
      store("ts", "{ state: () => ({ count: 0 }) }"),
    );
    await writeFile(
      join(root, "src/stores/cart.js"),
      store("js", "{ state: () => ({ count: 1 }) }"),
    );
    const target = join(root, "custom/stores/cart.ts");
    await writeFile(target, store("custom", "{ actions: { count() {} } }"));
    await writeFile(
      join(root, "entry.ts"),
      `import { defineComponent } from 'vue'
import { useCartStore } from '@/stores/cart'
export default defineComponent({ setup() { const { count } = useCartStore(); return { count } } })`,
    );
    const config = {
      root,
      configFile: false as const,
      logLevel: "silent" as const,
      plugins: [
        doctor({ rules: "pinia/state/no-store-destructure", maxWarnings: 0, cache: false }),
      ],
      resolve: { alias: { "@": join(root, "custom") }, extensions: [".ts", ".js"] },
      build: {
        write: false,
        lib: { entry: join(root, "entry.ts"), formats: ["es" as const] },
        rolldownOptions: { external: ["pinia", "vue"] },
      },
    };
    await build(config);
    await writeFile(target, store("custom", "{ state: () => ({ count: 2 }) }"));
    await expect(build(config)).rejects.toThrow(/PINIA0005.*custom\/stores\/cart\.ts/);
  });
});

test.each(["browser", "extension", "tsconfig"] as const)(
  "Pinia uses Vite's final store resolution (%s)",
  async (kind) => {
    await withProject(async (root) => {
      await installFixtureVue(root);
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          type: "module",
          dependencies: { pinia: "^3.0.0", vue: "^3.5.0" },
          ...(kind === "browser" && { browser: { "./mapped/cart.ts": "./mapped/client.ts" } }),
        }),
      );
      await mkdir(join(root, "mapped"));
      await mkdir(join(root, "src"));
      const store = (options: string) =>
        `import { defineStore } from 'pinia'\nexport const useCartStore = defineStore('cart', ${options})`;
      const state = store("{ state: () => ({ count: 0 }) }");
      const action = store("{ actions: { count() {} } }");
      const target = {
        browser: "mapped/client.ts",
        extension: "mapped/cart.tsx",
        tsconfig: "src/cart.ts",
      }[kind];
      await writeFile(join(root, target), action);
      if (kind === "browser") await writeFile(join(root, "mapped/cart.ts"), state);
      if (kind === "extension") await writeFile(join(root, "mapped/cart.js.ts"), state);
      if (kind === "extension")
        await writeFile(join(root, "barrel.ts"), "export { useCartStore } from '@cart'");
      if (kind === "tsconfig") {
        await writeFile(
          join(root, "tsconfig.json"),
          JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
        );
      }
      await writeFile(
        join(root, "entry.ts"),
        `import { defineComponent } from 'vue'
import { useCartStore } from '${{ browser: "@cart", extension: "./barrel", tsconfig: "@/cart" }[kind]}'
export default defineComponent({ setup() { const { count } = useCartStore(); return { count } } })`,
      );
      const config = {
        root,
        configFile: false as const,
        logLevel: "silent" as const,
        plugins: [
          doctor({ rules: "pinia/state/no-store-destructure", maxWarnings: 0, cache: false }),
        ],
        resolve:
          kind === "tsconfig"
            ? { tsconfigPaths: true }
            : {
                alias: {
                  "@cart": join(root, kind === "browser" ? "mapped/cart.ts" : "mapped/cart.js"),
                },
              },
        build: {
          write: false,
          lib: { entry: join(root, "entry.ts"), formats: ["es" as const] },
          rolldownOptions: { external: ["pinia", "vue"] },
        },
      };
      await build(config);
      await writeFile(join(root, target), state);
      await expect(build(config)).rejects.toThrow(new RegExp(`PINIA0005.*${target}`));
    });
  },
);

const destructureRule = "pinia/state/no-store-destructure";
const storeState = "{ state: () => ({ count: 0 }) }";
const storeAction = "{ actions: { count() {} } }";

async function piniaImports(root: string, specifier: string) {
  await installFixtureVue(root);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ type: "module", dependencies: { pinia: "^3.0.0", vue: "^3.5.0" } }),
  );
  await writeFile(
    join(root, "entry.ts"),
    `import { defineComponent } from 'vue'
import { useCartStore } from '${specifier}'
export default defineComponent({ setup() { const { count } = useCartStore(); return { count } } })`,
  );
  const store = async (name: string, options: string) =>
    writeFile(
      join(root, `${name}.ts`),
      `import { defineStore } from 'pinia'; export const useCartStore = defineStore('${name}', ${options})`,
    );
  await store("cart", storeState);
  await store("action", storeAction);
  return store;
}

function piniaBuild(root: string) {
  return {
    root,
    configFile: false as const,
    logLevel: "silent" as const,
    plugins: [doctor({ rules: destructureRule, maxWarnings: 0, cache: false })],
    build: {
      write: false,
      lib: { entry: join(root, "entry.ts"), formats: ["es" as const] },
      rolldownOptions: { external: ["pinia", "vue"] },
    },
  };
}

test("Pinia uses the import resolved after all buildStart hooks", async () => {
  await withProject(async (root) => {
    const store = await piniaImports(root, "@cart");
    const config = piniaBuild(root);
    let ready = false;
    const resolver = {
      name: "fixture/late-store-resolver",
      buildStart: {
        order: "post" as const,
        sequential: true,
        handler() {
          ready = true;
        },
      },
      resolveId(source: string) {
        if (source === "@cart") return join(root, ready ? "action.ts" : "cart.ts");
      },
    };
    await build({ ...config, plugins: [...config.plugins, resolver] });
    ready = false;
    await store("action", storeState);
    await expect(build({ ...config, plugins: [...config.plugins, resolver] })).rejects.toThrow(
      /PINIA0005.*action\.ts/,
    );
  });
});

test("Pinia uses an early resolver's answer only when Doctor observes it", async () => {
  await withProject(async (root) => {
    await piniaImports(root, "@cart");
    const config = piniaBuild(root);
    const resolver: Plugin = {
      name: "fixture/early-store-resolver",
      enforce: "pre",
      resolveId: {
        order: "pre",
        handler(source) {
          if (source === "@cart") return join(root, "cart.ts");
        },
      },
    };
    const [doctorPlugin] = config.plugins;
    const observingDoctor = { ...doctorPlugin, enforce: "pre" as const };
    await build({ ...config, plugins: [resolver, observingDoctor] });
    await expect(build({ ...config, plugins: [observingDoctor, resolver] })).rejects.toThrow(
      /PINIA0005.*cart\.ts/,
    );
  });
});

test("Pinia does not pair deduplicated imports with native asset edges", async () => {
  await withProject(async (root) => {
    await piniaImports(root, "@use");
    const entry = join(root, "entry.ts");
    await writeFile(
      entry,
      `import { defineComponent } from 'vue'
import '@side'
import { useCartStore } from '@use'
import '@state'
export const logo = new URL('./logo.svg', import.meta.url)
export default defineComponent({ setup() { const { count } = useCartStore(); return { count } } })`,
    );
    await writeFile(join(root, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const config = piniaBuild(root);
    const resolver: Plugin = {
      name: "fixture/early-store-and-asset-resolver",
      enforce: "pre",
      resolveId: {
        order: "pre",
        handler(source) {
          if (source === "@side" || source === "@use") return join(root, "action.ts");
          if (source === "@state") return join(root, "cart.ts");
        },
      },
    };
    await build({
      ...config,
      plugins: [resolver, ...config.plugins],
      build: {
        write: false,
        ssr: entry,
        rolldownOptions: {
          ...config.build.rolldownOptions,
          experimental: { resolveNewUrlToAsset: true },
          moduleTypes: { ".svg": "asset" },
        },
      },
    });
  });
});

test.each([
  ["script setup", "const { count } = useCartStore()", destructureRule, "PINIA0005"],
  [
    "script",
    "useCartStore(); export default {}",
    "pinia/stores/no-module-scope-store",
    "PINIA0006",
  ],
])("Pinia uses the Vue %s submodule's imports", async (block, script, rule, diagnostic) => {
  await withProject(async (root) => {
    const nuxtRequire = createRequire(import.meta.resolve("nuxt"));
    const builderRequire = createRequire(nuxtRequire.resolve("@nuxt/vite-builder"));
    const { default: vue } = (await import(
      pathToFileURL(builderRequire.resolve("@vitejs/plugin-vue")).href
    )) as { default: () => Plugin };
    await piniaImports(root, "./cart");
    const entry = join(root, "entry.vue");
    await writeFile(
      entry,
      `<${block} lang="ts">\nimport { useCartStore } from './cart'\n${script}\n</script>\n<template><p>Cart</p></template>`,
    );
    const config = piniaBuild(root);
    await expect(
      build({
        ...config,
        plugins: [vue(), doctor({ rules: rule, maxWarnings: 0, cache: false })],
        build: { ...config.build, lib: { ...config.build.lib, entry } },
      }),
    ).rejects.toThrow(diagnostic);
  });
});

test("Pinia reclassifies a cached import when only its store changes", async () => {
  await withProject(async (root) => {
    const store = await piniaImports(root, "./cart");
    await store("cart", storeAction);
    const config = piniaBuild(root);
    const watcher = await build({ ...config, build: { ...config.build, watch: {} } });
    if (!("on" in watcher)) throw new Error("Expected a build watcher");
    try {
      const nextBuild = () =>
        new Promise<unknown>((resolve) => {
          const onEvent: Parameters<typeof watcher.on>[1] = (...[event]) => {
            if (typeof event !== "object" || (event.code !== "END" && event.code !== "ERROR"))
              return;
            watcher.off("event", onEvent);
            resolve(event.code === "ERROR" ? event.error : undefined);
          };
          watcher.on("event", onEvent);
        });
      expect(await nextBuild()).toBeUndefined();
      const rebuilt = nextBuild();
      await store("cart", storeState);
      expect(String(await rebuilt)).toContain("PINIA0005");
    } finally {
      await watcher.close();
    }
  });
});

test("Pinia does not apply SSR resolution to a client-only importer", async () => {
  await withProject(async (root) => {
    await piniaImports(root, "./cart");
    await rename(join(root, "action.ts"), join(root, "cart.js"));
    await writeFile(join(root, "server.ts"), "export const server = true;");
    const config = piniaBuild(root);
    const app = await createBuilder({
      ...config,
      environments: {
        client: { resolve: { extensions: [".js", ".ts"] } },
        ssr: {
          consumer: "server",
          resolve: { extensions: [".ts", ".js"] },
          build: { lib: { entry: join(root, "server.ts") } },
        },
      },
      builder: {
        async buildApp(builder) {
          await Promise.all(Object.values(builder.environments).map((env) => builder.build(env)));
        },
      },
    });
    await app.buildApp();
  });
});

test("Pinia resolves a relative dev import with the legacy plugin container", async () => {
  await withProject(async (root) => {
    await piniaImports(root, "./cart");
    const warn = vi.fn();
    const config = await resolveConfig({ root, configFile: false, logLevel: "silent" }, "serve");
    const legacy = { ...config, environments: undefined, logger: { ...config.logger, warn } };
    const resolveId = vi.fn(async (source: string) =>
      source === "./cart" ? { id: join(root, "cart.ts"), external: false } : null,
    );
    const events = { on: vi.fn(), off: vi.fn() };
    const server = {
      config: legacy,
      pluginContainer: { resolveId },
      watcher: { ...events, add: vi.fn() },
      ws: events,
    } as unknown as ViteDevServer;
    const { configResolved, configureServer, buildStart, closeBundle } = doctor({
      rules: destructureRule,
      run: "serve",
      cache: false,
    });
    if (
      typeof configResolved !== "function" ||
      typeof configureServer !== "function" ||
      typeof buildStart !== "function" ||
      typeof closeBundle !== "function"
    )
      throw new Error("Expected Doctor lifecycle hooks");
    await configResolved.call({} as ThisParameterType<typeof configResolved>, server.config);
    await configureServer.call({} as ThisParameterType<typeof configureServer>, server);
    try {
      await buildStart.call({} as ThisParameterType<typeof buildStart>, {} as never);
      await vi.waitFor(
        () => expect(warn).toHaveBeenCalledWith(expect.stringContaining("PINIA0005")),
        { timeout: 15_000 },
      );
      expect(resolveId).toHaveBeenCalledWith("./cart", join(root, "entry.ts"));
    } finally {
      await closeBundle.call({} as ThisParameterType<typeof closeBundle>);
    }
  });
});

test("Pinia cycles use Vite's resolved extension order", async () => {
  await withProject(async (root) => {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ type: "module", dependencies: { pinia: "^3.0.0" } }),
    );
    const xStore = (condition: string) => `
import { defineStore } from 'pinia'
import { useYStore } from './barrel'
export const useXStore = defineStore('x', () => ({ name: ${condition} ? useYStore().name : 'fallback' }))
`;
    await writeFile(join(root, "x.ts"), xStore("!import.meta.env.SSR"));
    await writeFile(join(root, "barrel.ts"), "export { useYStore } from './y'");
    await writeFile(
      join(root, "y.tsx"),
      `
import { defineStore } from 'pinia'
import { useXStore } from './x'
export const useYStore = defineStore('y', () => ({ name: useXStore().name }))
`,
    );
    await writeFile(join(root, "y.jsx"), "export const useYStore = () => ({ name: 'helper' })");
    await writeFile(join(root, "entry.ts"), "export { useXStore } from './x'");
    const config = {
      root,
      configFile: false as const,
      logLevel: "silent" as const,
      plugins: [doctor({ rules: "pinia/stores/no-circular-setup-state-read", cache: false })],
      build: {
        write: false,
        lib: { entry: join(root, "entry.ts"), formats: ["es" as const] },
        rolldownOptions: { external: ["pinia"] },
      },
    };
    await build(config);
    await expect(
      build({ ...config, resolve: { extensions: [".tsx", ".jsx", ".ts"] } }),
    ).rejects.toThrow(/PINIA0003/);
    const storeFirst = { resolve: { extensions: [".tsx", ".jsx", ".ts"] } };
    const helperFirst = { resolve: { extensions: [".jsx", ".tsx", ".ts"] } };
    await expect(
      build({ ...config, environments: { client: storeFirst, ssr: helperFirst } }),
    ).rejects.toThrow(/PINIA0003/);
    await build({ ...config, environments: { client: helperFirst, ssr: storeFirst } });
    await writeFile(join(root, "x.ts"), xStore("import.meta.env.SSR"));
    const ssrCycle = { ...config, environments: { client: helperFirst, ssr: storeFirst } };
    await build(ssrCycle);
    await expect(build({ ...ssrCycle, build: { ...config.build, ssr: true } })).rejects.toThrow(
      /PINIA0003/,
    );
    const app = await createBuilder({ ...ssrCycle, builder: { sharedPlugins: true } });
    await expect(app.buildApp()).rejects.toThrow(/PINIA0003/);
    const clientApp = await createBuilder({
      ...ssrCycle,
      builder: {
        async buildApp(builder) {
          await builder.build(builder.environments.client!);
        },
      },
    });
    await clientApp.buildApp();
    await expect(clientApp.build(clientApp.environments.ssr!)).rejects.toThrow(/PINIA0003/);

    await writeFile(join(root, "x.ts"), xStore("!import.meta.env.SSR"));
    const legacyConfig = await resolveConfig({ ...config, ...storeFirst }, "build");
    Reflect.deleteProperty(legacyConfig, "environments");
    const [plugin] = config.plugins;
    const { configResolved, buildStart } = plugin!;
    if (typeof configResolved !== "function" || typeof buildStart !== "function") {
      throw new Error("Expected callable Doctor hooks");
    }
    await configResolved.call({} as ThisParameterType<typeof configResolved>, legacyConfig);
    const legacyContext = {
      error(message: string): never {
        throw new Error(message);
      },
    } as ThisParameterType<typeof buildStart>;
    await expect(
      buildStart.call(legacyContext, {} as Parameters<typeof buildStart>[0]),
    ).rejects.toThrow(/PINIA0003/);

    await writeFile(
      join(root, "y.tsx"),
      `
import { defineStore } from 'pinia'
import { useXStore } from './reverse'
export const useYStore = defineStore('y', () => ({ name: useXStore().name }))
`,
    );
    await writeFile(join(root, "reverse.jsx"), "export { useXStore } from './x'");
    await writeFile(
      join(root, "reverse.tsx"),
      "export const useXStore = () => ({ name: 'helper' })",
    );
    const splitApp = await createBuilder({
      ...config,
      builder: { sharedPlugins: true },
      environments: { client: storeFirst, secondClient: { ...helperFirst, consumer: "client" } },
    });
    await splitApp.buildApp();
  });
});

test("an application shares its warning limit across the environments it builds", async () => {
  await withProject(async (root) => {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ type: "module", dependencies: { pinia: "^3.0.0" } }),
    );
    const cycle = (name: string, condition: string) => `
const use${name}A = defineStore('${name}-a', () => ({ name: ${condition} ? use${name}B().name : 'a' }))
const use${name}B = defineStore('${name}-b', () => ({ name: use${name}A().name }))
export { use${name}A }
`;
    const common = `import { defineStore } from 'pinia'\n${cycle("Client", "!import.meta.env.SSR")}`;
    const config = {
      root,
      configFile: false as const,
      logLevel: "silent" as const,
      plugins: [
        doctor({
          rules: "pinia/stores/no-circular-setup-state-read",
          config: { rules: { "pinia/stores/no-circular-setup-state-read": "warn" } },
          cache: false,
          maxWarnings: 1,
        }),
        { name: "fixture/noop-build-app", buildApp() {} },
      ],
      build: {
        write: false,
        lib: { entry: join(root, "entry.ts"), formats: ["es" as const] },
        rolldownOptions: { external: ["pinia"] },
      },
      environments: { client: {}, ssr: { consumer: "server" as const } },
    };
    await writeFile(join(root, "entry.ts"), common + cycle("Server", "import.meta.env.SSR"));
    await build(config);
    const app = await createBuilder({ ...config, builder: { sharedPlugins: true } });
    await expect(app.buildApp()).rejects.toThrow(/PINIA0003/);

    const customApp = await createBuilder({
      ...config,
      builder: {
        async buildApp(builder) {
          await Promise.all(Object.values(builder.environments).map((env) => builder.build(env)));
        },
      },
    });
    const clientApp = await createBuilder({
      ...config,
      builder: {
        async buildApp(builder) {
          await builder.build(builder.environments.client!);
        },
      },
    });
    await expect(customApp.buildApp()).rejects.toThrow(/PINIA0003/);
    await clientApp.buildApp();

    const first = await createBuilder(config);
    const second = await createBuilder(config);
    await first.build(first.environments.client!);
    await second.build(second.environments.ssr!);

    const third = await createBuilder(config);
    await third.build(third.environments.client!);
    const fourth = await createBuilder(config);
    await expect(third.build(third.environments.ssr!)).rejects.toThrow(/PINIA0003/);
    await fourth.build(fourth.environments.ssr!);

    await writeFile(
      join(root, "entry.ts"),
      `import { defineStore } from 'pinia'\n${cycle("Shared", "true")}`,
    );
    const sharedWarning = await createBuilder({ ...config, builder: { sharedPlugins: true } });
    await sharedWarning.buildApp();
  });
});

test("a build with a warning limit respects the Doctor plugin's environment filter", async () => {
  await withProject(async (root) => {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ type: "module", dependencies: { pinia: "^3.0.0" } }),
    );
    await writeFile(
      join(root, "entry.ts"),
      `import { defineStore } from 'pinia'
export const useA = defineStore('a', () => ({ name: useB().name }))
export const useB = defineStore('b', () => ({ name: useA().name }))`,
    );
    const plugin = doctor({
      rules: "pinia/stores/no-circular-setup-state-read",
      config: { rules: { "pinia/stores/no-circular-setup-state-read": "warn" } },
      cache: false,
      maxWarnings: 0,
    });
    plugin.applyToEnvironment = ({ name }) => name === "client";
    const config = {
      root,
      configFile: false as const,
      logLevel: "silent" as const,
      plugins: [plugin],
      build: {
        write: false,
        lib: { entry: join(root, "entry.ts"), formats: ["es" as const] },
        rolldownOptions: { external: ["pinia"] },
      },
    };
    await build({ ...config, build: { ...config.build, ssr: true } });
    await expect(build(config)).rejects.toThrow(/PINIA0003/);
  });
});

test("a shared Plugin Surface runs once across a Vite application's environments", async () => {
  await withProject(async (root) => {
    let runs = 0;
    const plugin = doctor({
      rules: "vite",
      cache: false,
      extensions: [
        {
          name: "fixture/count-runs",
          setup(api) {
            api.registerProjectInventoryContributor({
              name: "fixture",
              contribute() {
                runs++;
                return {};
              },
            });
          },
        },
      ],
    });
    const builder = await createBuilder({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [plugin],
      builder: { sharedPlugins: true },
      build: {
        write: false,
        lib: { entry: join(root, "entry.ts"), formats: ["es"] },
      },
      environments: { ssr: { consumer: "server" } },
    });
    await builder.buildApp();
    expect(Object.keys(builder.environments)).toEqual(["client", "ssr"]);
    expect(runs).toBe(1);
  });
});

test("fails a Vite build when the Doctor Run is incomplete", async () => {
  await withProject(async (root) => {
    const incompleteRule = createRule({
      meta: {
        id: "fixture/incomplete-evidence",
        title: "Incomplete evidence fixture",
        category: "inventory",
        severity: "info",
        execution: "workspace",
      },
      create() {
        return {
          onProjectStart(project) {
            project.evidenceGaps = [
              {
                source: "fixture",
                message: "Fixture evidence is missing.",
                files: ["fixture.manifest.json"],
              },
            ];
          },
        };
      },
    });
    const plugin = doctor({
      rules: incompleteRule.meta.id,
      cache: false,
      extensions: [
        defineDoctorExtension({
          name: "fixture/incomplete-evidence",
          rulePacks: [
            defineRulePack({
              name: "fixture",
              version: "0.0.0",
              rules: [incompleteRule],
              presets: { recommended: [incompleteRule.meta.id] },
            }),
          ],
        }),
      ],
    });

    await expect(
      build({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [plugin],
        build: {
          write: false,
          lib: { entry: join(root, "entry.ts"), formats: ["es"] },
        },
      }),
    ).rejects.toThrow(/Fixture evidence is missing/);
  });
});

test("fails a Vite build when the Vue runtime cannot be resolved", async () => {
  await withProject(async (root) => {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ type: "module", dependencies: { vue: "^3.5.0" } }),
    );
    await mkdir(join(root, "node_modules/vue"), { recursive: true });
    await writeFile(
      join(root, "node_modules/vue/package.json"),
      JSON.stringify({ name: "custom-vue", version: "5.0.0" }),
    );
    const plugin = doctor({ framework: "vue", cache: false });

    await expect(
      build({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [plugin],
        build: {
          write: false,
          lib: { entry: join(root, "entry.ts"), formats: ["es"] },
        },
      }),
    ).rejects.toThrow(/DOC0022|unresolved runtime/i);
  });
});

test("warn mode keeps an incomplete Vite build running", async () => {
  await withProject(async (root) => {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ type: "module", dependencies: { vue: "^3.5.0" } }),
    );
    await mkdir(join(root, "node_modules/vue"), { recursive: true });
    await writeFile(
      join(root, "node_modules/vue/package.json"),
      JSON.stringify({ name: "custom-vue", version: "5.0.0" }),
    );
    const plugin = doctor({ framework: "vue", mode: "warn", cache: false });
    const warnings: string[] = [];
    const customLogger: Logger = {
      info() {},
      warn(message) {
        warnings.push(message);
      },
      warnOnce(message) {
        warnings.push(message);
      },
      error() {},
      clearScreen() {},
      hasErrorLogged() {
        return false;
      },
      hasWarned: false,
    };

    await expect(
      build({
        root,
        configFile: false,
        logLevel: "warn",
        customLogger,
        plugins: [plugin],
        build: {
          write: false,
          lib: { entry: join(root, "entry.ts"), formats: ["es"] },
        },
      }),
    ).resolves.toBeDefined();
    expect(warnings.join("\n")).toMatch(/DOC0022|incomplete|unresolved runtime/i);
  });
});
