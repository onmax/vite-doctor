import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { expect, test } from "vite-plus/test";
import {
  defineDoctorExtension,
  detectProject,
  runDoctor,
  type DoctorRule,
} from "../../../src/core/index.ts";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import {
  moduleExplicitRuntimeImports,
  moduleRequireMeta,
  moduleResolveRuntimePaths,
} from "../../../src/rule-packs/nuxt/rules/nuxt.ts";
import { nuxtRulePacks } from "../../../src/rule-packs/nuxt/rules/index.ts";

const modulePackageJson = JSON.stringify({
  name: "@acme/nuxt-analytics",
  type: "module",
  exports: { ".": { types: "./dist/types.d.mts", import: "./dist/module.mjs" } },
  main: "./dist/module.mjs",
  dependencies: { "@nuxt/kit": "^4.0.0" },
  devDependencies: { "@nuxt/module-builder": "^1.0.0", nuxt: "^4.0.0" },
});

const completeModule = `import { addPlugin, createResolver, defineNuxtModule } from '@nuxt/kit'

export interface ModuleOptions { enabled: boolean }

export default defineNuxtModule<ModuleOptions>({
  meta: { name: '@acme/nuxt-analytics', configKey: 'analytics', compatibility: { nuxt: '>=4.0.0' } },
  defaults: { enabled: true },
  setup(options, nuxt) {
    const resolver = createResolver(import.meta.url)
    addPlugin(resolver.resolve('./runtime/plugin'))
  },
})
`;

function modulePackage(files: Record<string, string>): Record<string, string> {
  return {
    "package.json": modulePackageJson,
    "src/runtime/plugin.ts": "export default {}\n",
    "src/module.ts": completeModule,
    ...files,
  };
}

async function run(rule: DoctorRule, files: Record<string, string>) {
  return runProjectFixture({ framework: "nuxt", rules: [rule], files });
}

test("Project Inventory identifies a module package entry and runtime directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-module-inventory-"));
  try {
    writeFiles(root, modulePackage({ "playground/nuxt.config.ts": "export default {}\n" }));
    const project = await detectProject(root, "nuxt");
    expect(project.nuxtModuleDefinitions).toEqual([
      {
        kind: "package",
        entry: join(root, "src/module.ts"),
        root: join(root, "src"),
        runtimeDir: join(root, "src/runtime"),
        layer: false,
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Project Inventory ignores packages without a default-exported defineNuxtModule", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-module-inventory-"));
  try {
    writeFiles(
      root,
      modulePackage({
        "src/module.ts": `import { defineNuxtModule } from '@nuxt/kit'\nexport const helper = defineNuxtModule({ setup() {} })\n`,
      }),
    );
    const project = await detectProject(root, "nuxt");
    expect(project.nuxtModuleDefinitions).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Project Inventory lists local modules of a Nuxt app", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-module-inventory-"));
  try {
    writeFiles(root, {
      "package.json": JSON.stringify({ dependencies: { nuxt: "^4.0.0" } }),
      "nuxt.config.ts": "export default defineNuxtConfig({})\n",
      "modules/single.ts": "export default () => {}\n",
      "modules/feature/index.ts": "export default () => {}\n",
      "modules/feature/runtime/plugin.ts": "export default {}\n",
    });
    const project = await detectProject(root, "nuxt");
    expect(project.nuxtModuleDefinitions).toEqual([
      {
        kind: "local",
        entry: join(root, "modules/feature/index.ts"),
        root: join(root, "modules/feature"),
        runtimeDir: join(root, "modules/feature/runtime"),
      },
      {
        kind: "local",
        entry: join(root, "modules/single.ts"),
        root: join(root, "modules/single.ts"),
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("require-meta reports each missing meta field on a module package entry", async () => {
  const result = await run(
    moduleRequireMeta,
    modulePackage({
      "src/module.ts": `import { defineNuxtModule } from '@nuxt/kit'

export default defineNuxtModule({
  setup(options, nuxt) {},
})
`,
    }),
  );

  expect(result.diagnostics.map((item) => item.code)).toEqual(["NUXT0081", "NUXT0081", "NUXT0081"]);
  const messages = result.diagnostics.map((item) => item.message).join("\n");
  expect(messages).toContain("no meta.name");
  expect(messages).toContain("no meta.configKey");
  expect(messages).toContain("no meta.compatibility");
  expect(result.diagnostics[0]?.suggestion).toContain("name: '@acme/nuxt-analytics'");
  expect(result.diagnostics[1]?.suggestion).toContain("configKey: 'analytics'");
  expect(result.diagnostics[0]?.range?.line).toBe(3);
});

test("require-meta accepts a complete module definition", async () => {
  const result = await run(moduleRequireMeta, modulePackage({}));
  expect(result.diagnostics).toEqual([]);
});

test("require-meta reports only missing fields of an existing meta object", async () => {
  const result = await run(
    moduleRequireMeta,
    modulePackage({
      "src/module.ts": `import { defineNuxtModule } from '@nuxt/kit'
const mod = defineNuxtModule({
  meta: { name: '@acme/nuxt-analytics', configKey: 'analytics' },
  setup() {},
})
export default mod
`,
    }),
  );
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.message).toContain("no meta.compatibility");
  expect(result.diagnostics[0]?.range?.line).toBe(3);
});

test("require-meta does not require configKey when the module takes no options or the name is a key", async () => {
  const withoutOptions = await run(
    moduleRequireMeta,
    modulePackage({
      "src/module.ts": `import { defineNuxtModule } from '@nuxt/kit'
export default defineNuxtModule({
  meta: { name: '@acme/nuxt-analytics', compatibility: { nuxt: '>=4.0.0' } },
  setup(_options, nuxt) {},
})
`,
    }),
  );
  const identifierName = await run(
    moduleRequireMeta,
    modulePackage({
      "src/module.ts": `import { defineNuxtModule } from '@nuxt/kit'
export default defineNuxtModule<{ enabled: boolean }>().with({
  meta: { name: 'analytics', compatibility: { nuxt: '>=4.0.0' } },
  defaults: { enabled: true },
  setup(options) {},
})
`,
    }),
  );
  expect(withoutOptions.diagnostics).toEqual([]);
  expect(identifierName.diagnostics).toEqual([]);
});

test("require-meta skips meta it cannot read statically", async () => {
  const result = await run(
    moduleRequireMeta,
    modulePackage({
      "src/module.ts": `import { defineNuxtModule } from '@nuxt/kit'
import { meta } from './meta'
export default defineNuxtModule({ meta, setup(options) {} })
`,
    }),
  );
  expect(result.diagnostics).toEqual([]);
});

test("require-meta ignores local modules and Nuxt apps", async () => {
  const result = await run(moduleRequireMeta, {
    "nuxt.config.ts": "export default defineNuxtConfig({})\n",
    "modules/local.ts": `import { defineNuxtModule } from '@nuxt/kit'\nexport default defineNuxtModule({ setup(options) {} })\n`,
    "src/module.ts": `import { defineNuxtModule } from '@nuxt/kit'\nexport default defineNuxtModule({ setup(options) {} })\n`,
  });
  expect(result.diagnostics).toEqual([]);
});

test("resolve-runtime-paths wraps relative kit paths with the module resolver", async () => {
  const source = `import { addComponentsDir, addImportsDir, addPlugin, addServerHandler, createResolver, defineNuxtModule } from '@nuxt/kit'

export default defineNuxtModule({
  meta: { name: '@acme/nuxt-analytics', configKey: 'analytics', compatibility: { nuxt: '>=4.0.0' } },
  setup() {
    const { resolve } = createResolver(import.meta.url)
    addPlugin('./runtime/plugin')
    addPlugin({ src: './runtime/plugin', mode: 'client' })
    addComponentsDir({ path: './runtime/components' })
    addImportsDir(['./runtime/composables', resolve('./runtime/utils')])
    addServerHandler({ route: '/api/track', handler: './runtime/server/api/track.post' })
  },
})
`;
  const result = await run(
    moduleResolveRuntimePaths,
    modulePackage({
      "src/module.ts": source,
      "src/runtime/components/Tracker.vue": "<template><div /></template>\n",
      "src/runtime/composables/useTracker.ts": "export const useTracker = () => {}\n",
      "src/runtime/server/api/track.post.ts": "export default {}\n",
    }),
  );

  expect(result.diagnostics.map((item) => item.code)).toEqual(Array(5).fill("NUXT0082"));
  expect(result.diagnostics.every((item) => item.fix?.kind === "safe")).toBe(true);
  expect(applyEdits(source, result.diagnostics)).toContain(
    "addPlugin(resolve('./runtime/plugin'))\n    addPlugin({ src: resolve('./runtime/plugin'), mode: 'client' })\n    addComponentsDir({ path: resolve('./runtime/components') })\n    addImportsDir([resolve('./runtime/composables'), resolve('./runtime/utils')])\n    addServerHandler({ route: '/api/track', handler: resolve('./runtime/server/api/track.post') })",
  );
});

test("resolve-runtime-paths only suggests a resolver when none is in scope", async () => {
  const result = await run(
    moduleResolveRuntimePaths,
    modulePackage({
      "src/module.ts": `import { addPlugin, createResolver, defineNuxtModule } from '@nuxt/kit'

function other() {
  const resolver = createResolver(import.meta.url)
  return resolver
}

export default defineNuxtModule({
  setup() {
    addPlugin('./runtime/plugin')
    addPlugin('./runtime/missing')
  },
})
`,
    }),
  );

  expect(result.diagnostics).toHaveLength(2);
  expect(result.diagnostics.every((item) => item.fix === null)).toBe(true);
  expect(result.diagnostics[0]?.suggestion).toContain("createResolver(import.meta.url)");
});

test("resolve-runtime-paths does not offer an edit when the target is not next to the module", async () => {
  const result = await run(
    moduleResolveRuntimePaths,
    modulePackage({
      "src/module.ts": `import { addPlugin, createResolver, defineNuxtModule } from '@nuxt/kit'
export default defineNuxtModule({
  setup() {
    const resolver = createResolver(import.meta.url)
    addPlugin('./src/runtime/plugin')
  },
})
`,
    }),
  );
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.fix).toBeNull();
});

test("resolve-runtime-paths accepts resolved, aliased, and non-kit paths", async () => {
  const result = await run(
    moduleResolveRuntimePaths,
    modulePackage({
      "src/module.ts": `import { addPlugin, addServerHandler, createResolver, defineNuxtModule } from '@nuxt/kit'
import { addPlugin as addVitePlugin } from './vite'
export default defineNuxtModule({
  setup() {
    const resolver = createResolver(import.meta.url)
    addPlugin(resolver.resolve('./runtime/plugin'))
    addPlugin('#build/my-plugin.mjs')
    addPlugin('@acme/nuxt-analytics/runtime/plugin')
    addServerHandler({ handler: resolver.resolve('./runtime/server/api/track.post') })
    addVitePlugin('./runtime/plugin')
  },
})
`,
      "src/vite.ts": "export function addPlugin(path: string) {}\n",
    }),
  );
  expect(result.diagnostics).toEqual([]);
});

test("resolve-runtime-paths ignores Nuxt app code outside module definitions", async () => {
  const result = await run(moduleResolveRuntimePaths, {
    "nuxt.config.ts": "export default defineNuxtConfig({})\n",
    "app/plugins/setup.ts": `import { addPlugin } from '@nuxt/kit'\naddPlugin('./runtime/plugin')\n`,
    "app/plugins/runtime/plugin.ts": "export default {}\n",
  });
  expect(result.diagnostics).toEqual([]);
});

test("resolve-runtime-paths reports local module paths that only exist next to the module", async () => {
  const result = await run(moduleResolveRuntimePaths, {
    "nuxt.config.ts": "export default defineNuxtConfig({})\n",
    "modules/analytics/index.ts": `import { addPlugin, addServerHandler, defineNuxtModule } from '@nuxt/kit'
export default defineNuxtModule({
  setup() {
    addPlugin('./runtime/plugin')
    addServerHandler({ handler: './server/api/health' })
  },
})
`,
    "modules/analytics/runtime/plugin.ts": "export default {}\n",
    "server/api/health.ts": "export default {}\n",
  });

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.message).toContain("modules/analytics/runtime/plugin");
});

test("explicit-runtime-imports reports auto-imported calls in module runtime files", async () => {
  const source = `export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig()
  const enabled = ref(config.public.analytics)
  useRuntimeConfig()
})
`;
  const result = await run(
    moduleExplicitRuntimeImports,
    modulePackage({ "src/runtime/plugin.ts": source }),
  );

  expect(result.diagnostics.map((item) => item.code)).toEqual(["NUXT0083", "NUXT0083", "NUXT0083"]);
  expect(result.diagnostics.map((item) => item.message.split("()")[0])).toEqual([
    "defineNuxtPlugin",
    "useRuntimeConfig",
    "ref",
  ]);
  expect(applyEdits(source, result.diagnostics)).toBe(
    `import { defineNuxtPlugin, ref, useRuntimeConfig } from '#imports'\n${source}`,
  );
});

test("explicit-runtime-imports appends after existing imports in server and SFC runtime files", async () => {
  const server = `import { z } from "zod";

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, z.object({}).parse);
  return body;
});
`;
  const component = `<script setup lang="ts">
import { computed } from 'vue'
const route = useRoute()
const path = computed(() => route.path)
</script>

<template><p>{{ path }}</p></template>
`;
  const result = await run(
    moduleExplicitRuntimeImports,
    modulePackage({
      "src/runtime/server/api/track.post.ts": server,
      "src/runtime/components/Tracker.vue": component,
    }),
  );

  const byFile = (suffix: string) =>
    result.diagnostics.filter((item) => item.file.endsWith(suffix));
  expect(applyEdits(server, byFile("track.post.ts"))).toContain(
    `import { z } from "zod";\nimport { defineEventHandler, readValidatedBody } from "#imports";\n`,
  );
  expect(applyEdits(component, byFile("Tracker.vue"))).toContain(
    `import { computed } from 'vue'\nimport { useRoute } from '#imports'\nconst route`,
  );
});

test("explicit-runtime-imports accepts explicit imports and local bindings", async () => {
  const result = await run(
    moduleExplicitRuntimeImports,
    modulePackage({
      "src/runtime/plugin.ts": `import { defineNuxtPlugin, useRuntimeConfig } from '#imports'
import { ref as vueRef } from 'vue'
function useState(key: string) { return key }
declare function useCookie(name: string): unknown
export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig()
  const enabled = vueRef(config.public.analytics)
  useState('x')
  useCookie('session')
  $fetch('/api/track')
})
`,
    }),
  );
  expect(result.diagnostics).toEqual([]);
});

test.each([
  "function helper() { const useRuntimeConfig = () => ({}); useRuntimeConfig() }",
  "function helper(useRuntimeConfig: () => unknown) { useRuntimeConfig() }",
  "{ const useRuntimeConfig = () => ({}); useRuntimeConfig() }",
  "const helper = function useRuntimeConfig() { useRuntimeConfig() }",
  "try {} catch (useRuntimeConfig) { useRuntimeConfig() }",
  "for (const useRuntimeConfig of []) { useRuntimeConfig() }",
])("explicit-runtime-imports distinguishes sibling scopes: %s", async (binding) => {
  const source = `import { defineNuxtPlugin } from '#imports'
${binding}
export default defineNuxtPlugin(() => useRuntimeConfig())
`;
  const result = await run(
    moduleExplicitRuntimeImports,
    modulePackage({
      "src/runtime/plugin.ts": source,
    }),
  );
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.range?.start).toBe(source.lastIndexOf("useRuntimeConfig()"));
  const fixed = applyEdits(source, result.diagnostics);
  expect(fixed).toContain("import { useRuntimeConfig } from '#imports'");
  const rerun = await run(
    moduleExplicitRuntimeImports,
    modulePackage({
      "src/runtime/plugin.ts": fixed,
    }),
  );
  expect(rerun.diagnostics).toEqual([]);
});

test("explicit-runtime-imports preserves SFC offsets across sibling scopes", async () => {
  const source = `<script setup lang="ts">
function helper() { const useRuntimeConfig = () => ({}); useRuntimeConfig() }
const config = useRuntimeConfig()
</script>
<template><p>{{ config }}</p></template>
`;
  const result = await run(
    moduleExplicitRuntimeImports,
    modulePackage({
      "src/runtime/components/Config.vue": source,
    }),
  );
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.range?.start).toBe(source.lastIndexOf("useRuntimeConfig()"));
  const fixed = applyEdits(source, result.diagnostics);
  expect(fixed).toContain(`<script setup lang="ts">
import { useRuntimeConfig } from '#imports'
`);
  const rerun = await run(
    moduleExplicitRuntimeImports,
    modulePackage({
      "src/runtime/components/Config.vue": fixed,
    }),
  );
  expect(rerun.diagnostics).toEqual([]);
});

test("explicit-runtime-imports respects enclosing and hoisted bindings", async () => {
  const result = await run(
    moduleExplicitRuntimeImports,
    modulePackage({
      "src/runtime/plugin.ts": `import { defineNuxtPlugin } from '#imports'
export default defineNuxtPlugin(() => {
  useRuntimeConfig()
  if (true) { var useRuntimeConfig = () => ({}) }
  function nested() { useRuntimeConfig() }
  return nested
})
`,
    }),
  );
  expect(result.diagnostics).toEqual([]);
});

test("explicit-runtime-imports ignores module definition code, local modules, layers, and apps", async () => {
  const runtimeSource = "export default defineNuxtPlugin(() => useRuntimeConfig())\n";
  const moduleSetup = await run(
    moduleExplicitRuntimeImports,
    modulePackage({ "src/setup.ts": runtimeSource }),
  );
  const localModule = await run(moduleExplicitRuntimeImports, {
    "nuxt.config.ts": "export default defineNuxtConfig({})\n",
    "modules/analytics/index.ts": `import { defineNuxtModule } from '@nuxt/kit'\nexport default defineNuxtModule({ setup() {} })\n`,
    "modules/analytics/runtime/plugin.ts": runtimeSource,
    "app/plugins/analytics.ts": runtimeSource,
  });
  const layerModule = await run(
    moduleExplicitRuntimeImports,
    modulePackage({
      "nuxt.config.ts": "export default defineNuxtConfig({})\n",
      "src/runtime/plugin.ts": runtimeSource,
    }),
  );
  expect(moduleSetup.diagnostics).toEqual([]);
  expect(localModule.diagnostics).toEqual([]);
  expect(layerModule.diagnostics).toEqual([]);
});

test("Nuxt Rule Pack activates module author rules for a module package", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-module-package-"));
  try {
    writeFiles(
      root,
      modulePackage({
        "src/module.ts": `import { addPlugin, defineNuxtModule } from '@nuxt/kit'
export default defineNuxtModule({
  setup() {
    addPlugin('./runtime/plugin')
  },
})
`,
        "src/runtime/plugin.ts": "export default defineNuxtPlugin(() => {})\n",
        "playground/nuxt.config.ts":
          "export default defineNuxtConfig({ modules: ['../src/module'] })\n",
        "playground/app/app.vue": "<template><div /></template>\n",
      }),
    );
    const result = await runDoctor({
      root,
      framework: "nuxt",
      rules: "nuxt/module/*",
      runtimeTarget: { nuxt: "4.0.0", nitro: "2.0.0", h3: "1.0.0", vue: "3.5.0" },
      extensions: [defineDoctorExtension({ name: "builtin-nuxt", rulePacks: nuxtRulePacks() })],
    });
    const moduleDiagnostics = result.diagnostics.filter((item) =>
      item.ruleId.startsWith("nuxt/module/"),
    );
    expect(moduleDiagnostics.map((item) => `${item.code}:${item.ruleId}`).sort()).toEqual([
      "NUXT0081:nuxt/module/require-meta",
      "NUXT0081:nuxt/module/require-meta",
      "NUXT0082:nuxt/module/resolve-runtime-paths",
      "NUXT0083:nuxt/module/explicit-runtime-imports",
    ]);
    expect(
      moduleDiagnostics.every((item) => item.docs?.startsWith("https://vite-doctor.onmax.me/")),
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("module author rules are part of the Nuxt recommended preset", () => {
  const nuxtPack = nuxtRulePacks().find((pack) => pack.name === "vite-doctor/nuxt");
  for (const id of [
    "nuxt/module/require-meta",
    "nuxt/module/resolve-runtime-paths",
    "nuxt/module/explicit-runtime-imports",
  ]) {
    expect(nuxtPack?.presets.recommended).toContain(id);
  }
});

function writeFiles(root: string, files: Record<string, string>) {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
}

function applyEdits(source: string, diagnostics: Array<{ fix?: { edits: any[] } | null }>) {
  const seen = new Set<string>();
  const edits = diagnostics
    .flatMap((item) => item.fix?.edits ?? [])
    .filter((edit) => {
      const key = `${edit.range.start}:${edit.range.end}:${edit.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.range.start - a.range.start);
  let text = source;
  for (const edit of edits)
    text = text.slice(0, edit.range.start) + edit.text + text.slice(edit.range.end);
  return text;
}
