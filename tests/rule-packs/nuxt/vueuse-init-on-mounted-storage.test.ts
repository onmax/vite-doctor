import { afterAll, expect, test } from "vite-plus/test";
import { createProjectFixture, runRuleFixture } from "../../../src/core/testkit.ts";
import vueUseRulePack, {
  preferUseStorage,
  requireInitOnMountedStorage,
} from "../../../src/rule-packs/nuxt/rules/vueuse.ts";

const ruleId = "vueuse/ssr/require-init-on-mounted-storage";
const vueUseNuxt = { "@vueuse/core": "^14.0.0", "@vueuse/nuxt": "^14.0.0" };
const ssrProject = createProjectFixture({
  framework: "nuxt",
  files: { "app/.gitkeep": "" },
  dependencies: vueUseNuxt,
});
afterAll(() => ssrProject.dispose());

async function lines(files: Record<string, string>) {
  const result = await ssrProject.run({ rule: requireInitOnMountedStorage, files });
  return result.diagnostics.map(
    (diagnostic) => `${diagnostic.file.split("/").pop()}:${diagnostic.range?.line}`,
  );
}

function component(script: string, template = "<div />") {
  return `<script setup lang="ts">\n${script}\n</script>\n<template>${template}</template>\n`;
}

test("is in the VueUse Recommended Preset", () => {
  expect(vueUseRulePack.presets.recommended).toContain(ruleId);
});

test("reports auto-imported storage composables whose value reaches the hydrating render", async () => {
  const result = await ssrProject.run({
    rule: requireInitOnMountedStorage,
    files: {
      "app/components/Kpi.vue": component(
        `const target = useLocalStorage<number | null>('kpi-target', null, { serializer })
const model = computed({ get: () => target.value, set: (value) => { target.value = value } })`,
        "<span>{{ model }}</span>",
      ),
      "app/components/Plan.vue": component(
        `const granularity = useSessionStorage('plan-granularity', 'month')
const label = computed(() => granularity.value === 'week' ? 'Week' : 'Month')`,
        "<h2>{{ label }}</h2>",
      ),
      "app/components/Search.vue": component(
        `const settings = useLocalStorage('search', {})`,
        "<input :value='settings.query'>",
      ),
    },
  });
  expect(result.diagnostics.map((diagnostic) => [diagnostic.file, diagnostic.code])).toEqual([
    [expect.stringContaining("Kpi.vue"), "NUXT0085"],
    [expect.stringContaining("Plan.vue"), "NUXT0085"],
    [expect.stringContaining("Search.vue"), "NUXT0085"],
  ]);
  expect(result.diagnostics[0]).toMatchObject({ ruleId, severity: "warn" });
  expect(result.diagnostics[0]!.suggestion).toContain("initOnMounted: true");
  expect(result.diagnostics[0]!.suggestion).toContain("useCookie()");
});

test("reports composables that return or cache storage refs", async () => {
  expect(
    await lines({
      "app/composables/usePersistedState.ts": `const cache: Record<string, any> = {}
function shared(key: string, value: unknown) {
  if (import.meta.server) return ref(value)
  if (!cache[key]) cache[key] = useLocalStorage(key, value)
  return cache[key]
}
export function usePersistedState(key: string, defaults: object) {
  const storage = import.meta.client
    ? useLocalStorage(\`persisted-\${key}\`, defaults, { mergeDefaults: true })
    : ref(defaults)
  const value = computed(() => storage.value)
  return { value, shared: shared(key, defaults) }
}`,
    }),
  ).toEqual(["usePersistedState.ts:4", "usePersistedState.ts:9"]);
});

test("accepts storage initialized on mount and reads outside the hydrating render", async () => {
  expect(
    await lines({
      "app/composables/useTargetUnit.ts": `export function useTargetUnit() {
  const unit = useState('unit', () => 'pieces')
  if (import.meta.client) {
    const stored = useLocalStorage('unit', 'pieces', { initOnMounted: true, writeDefaults: false })
    watch(stored, (value) => { unit.value = value })
  }
  return unit
}`,
      "app/components/Overview.vue": component(
        `const persisted = useLocalStorage('view', {})
const viewMode = ref('list')
function toggle() { persisted.value = { ...persisted.value, viewMode: viewMode.value } }
watch(viewMode, () => { persisted.value = { ...persisted.value, viewMode: viewMode.value } }, { immediate: true })
onMounted(() => { viewMode.value = persisted.value.viewMode ?? 'list' })`,
        "<button @click='persisted = {}'>{{ viewMode }}</button>",
      ),
      "app/components/Deferred.vue": component(
        `onMounted(() => { const draft = useLocalStorage('draft', ''); console.log(draft.value) })`,
      ),
      "app/components/Unknown.vue": component(
        `const draft = useLocalStorage('draft', '', options)
const other = useLocalStorage('other', '', { ...options })`,
        "{{ draft }} {{ other }}",
      ),
      "app/components/Panel.client.vue": component(
        `const open = useLocalStorage('panel-open', false)`,
        "<div v-if='open' />",
      ),
      "server/api/state.ts": `export default defineEventHandler(() => useStorage('cache').getItem('key'))`,
    }),
  ).toEqual([]);
});

test("reports initOnMounted: false and explicit browser storage in useStorage", async () => {
  expect(
    await lines({
      "app/components/Theme.vue": component(
        `import { useStorage as useStore } from '@vueuse/core'
const theme = useLocalStorage('theme', 'light', { initOnMounted: false })
const tab = useStore('tab', 'one', sessionStorage)
const cookieBacked = useStore('cookie-backed', 'one')`,
        "{{ theme }} {{ tab }} {{ cookieBacked }}",
      ),
    }),
  ).toEqual(["Theme.vue:3", "Theme.vue:4"]);
});

test("reports useStorage default storage without @vueuse/nuxt cookie storage", async () => {
  const result = await runRuleFixture({
    rule: requireInitOnMountedStorage,
    framework: "nuxt",
    dependencies: { "@vueuse/core": "^14.0.0" },
    files: {
      "app/components/Theme.vue": component(
        `import { useStorage } from '@vueuse/core'
const theme = useStorage('theme', 'light')
const local = useLocalStorage('local', 'light')`,
        "{{ theme }} {{ local }}",
      ),
    },
  });
  expect(result.diagnostics.map((diagnostic) => diagnostic.range?.line)).toEqual([3]);
});

test("ignores Nuxt apps with ssr: false", async () => {
  const files = {
    "nuxt.config.ts": "export default defineNuxtConfig({ ssr: false })",
    "app/components/Kpi.vue": component(
      `const target = useLocalStorage('target', 1)`,
      "{{ target }}",
    ),
  };
  const spa = await runRuleFixture({
    rule: requireInitOnMountedStorage,
    framework: "nuxt",
    dependencies: vueUseNuxt,
    files,
  });
  const ssr = await runRuleFixture({
    rule: requireInitOnMountedStorage,
    framework: "nuxt",
    dependencies: vueUseNuxt,
    files: { ...files, "nuxt.config.ts": "export default defineNuxtConfig({ ssr: true })" },
  });
  expect(spa.diagnostics).toEqual([]);
  expect(ssr.diagnostics).toHaveLength(1);
});

test("prefer-use-storage recommends initOnMounted only in SSR apps", async () => {
  const files = {
    "app/components/Panel.vue": component(`localStorage.getItem('theme')`),
  };
  const ssr = await ssrProject.run({ rule: preferUseStorage, files });
  const spa = await runRuleFixture({
    rule: preferUseStorage,
    framework: "nuxt",
    dependencies: vueUseNuxt,
    files: { ...files, "nuxt.config.ts": "export default defineNuxtConfig({ ssr: false })" },
  });
  expect(ssr.diagnostics[0]!.suggestion).toBe(
    "Use VueUse useLocalStorage() for reactive client storage state. In SSR apps, pass { initOnMounted: true } so the first client render matches the server, or use useCookie() for state the server must render.",
  );
  expect(spa.diagnostics[0]!.suggestion).toBe(
    "Use VueUse useLocalStorage() for reactive client storage state.",
  );
});

test("reads ssr: false from any nuxt.config format and ignores a stale manifest", async () => {
  const kpi = component(`const target = useLocalStorage('target', 1)`, "{{ target }}");
  const run = (files: Record<string, string>) =>
    runRuleFixture({
      rule: requireInitOnMountedStorage,
      framework: "nuxt",
      dependencies: vueUseNuxt,
      files: { "app/components/Kpi.vue": kpi, ...files },
    });
  expect(
    (await run({ "nuxt.config.mjs": "export default defineNuxtConfig({ ssr: false })" }))
      .diagnostics,
  ).toEqual([]);
  expect(
    (
      await run({
        "nuxt.config.ts": "export default defineNuxtConfig({ ssr: false })",
        ".nuxt/doctor.manifest.json": JSON.stringify({ ssr: true }),
      })
    ).diagnostics,
  ).toEqual([]);
});

test("follows ssr: false of the workspace Nuxt app that owns the file", async () => {
  const kpi = component(`const target = useLocalStorage('target', 1)`, "{{ target }}");
  const result = await runRuleFixture({
    rule: requireInitOnMountedStorage,
    framework: "nuxt",
    dependencies: vueUseNuxt,
    files: {
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "app/components/Kpi.vue": kpi,
      "packages/spa/package.json": JSON.stringify({
        name: "spa",
        dependencies: { nuxt: "^4.0.0", ...vueUseNuxt },
      }),
      "packages/spa/nuxt.config.ts": "export default defineNuxtConfig({ ssr: false })",
      "packages/spa/app/components/Kpi.vue": kpi,
    },
  });
  expect(result.diagnostics.map((diagnostic) => diagnostic.file)).toEqual([
    expect.stringMatching(/(?<!packages\/spa\/)app\/components\/Kpi\.vue$/),
  ]);
});

test("matches template references by whole identifier", async () => {
  expect(
    await lines({
      "app/components/Mode.vue": component(
        `const theme = useLocalStorage('theme', 'light')\nconst themeMode = ref('auto')`,
        "{{ themeMode }} {{ settings.theme }}",
      ),
    }),
  ).toEqual([]);
});

test("explains that explicit browser storage throws during server rendering", async () => {
  const result = await ssrProject.run({
    rule: requireInitOnMountedStorage,
    files: {
      "app/components/Tab.vue": component(
        `import { useStorage } from '@vueuse/core'\nconst tab = useStorage('tab', 'one', sessionStorage)`,
        "{{ tab }}",
      ),
    },
  });
  expect(result.diagnostics[0]!.why).toContain(
    "sessionStorage, which does not exist on the server",
  );
  expect(result.diagnostics[0]!.suggestion).toContain(
    "useSessionStorage(key, value, { initOnMounted: true })",
  );
});

test("skips local or other-package bindings and functions only run on mount", async () => {
  expect(
    await lines({
      "app/components/Local.vue": component(
        `function useLocalStorage(key: string, value: string) { return ref(value) }\nconst draft = useLocalStorage('draft', '')`,
        "{{ draft }}",
      ),
      "app/components/Imported.vue": component(
        `import { useLocalStorage } from '~/utils/storage'\nconst draft = useLocalStorage('draft', '')`,
        "{{ draft }}",
      ),
      "app/components/Init.vue": component(
        `const init = () => useLocalStorage('key', '')\nonMounted(init)`,
      ),
    }),
  ).toEqual([]);
});

test("skips computed values that never render and console reads", async () => {
  expect(
    await lines({
      "app/components/Click.vue": component(
        `const stored = useLocalStorage('mode', 'a')\nconst label = computed(() => stored.value)\nfunction onClick() { alert(label.value) }`,
        "<button @click='onClick'>Go</button>",
      ),
      "app/components/Debug.vue": component(
        `const debug = useLocalStorage('debug', false)\nconsole.info(debug.value)`,
      ),
    }),
  ).toEqual([]);
});

test("only counts rendered template expressions and effects that assign state", async () => {
  expect(
    await lines({
      "app/components/Text.vue": component(
        `const theme = useLocalStorage('theme', 'light')`,
        "<span>theme</span>",
      ),
      "app/components/Log.vue": component(
        `const draft = useLocalStorage('draft', '')\nwatchEffect(() => console.log(draft.value))`,
      ),
      "app/components/Label.vue": component(
        `const stored = useLocalStorage('count', 1)\nconst label = ref('')\nwatchEffect(() => { label.value = String(stored.value) })`,
        "{{ label }}",
      ),
    }),
  ).toEqual(["Label.vue:2"]);
});
