import { expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import { noModuleScopeRequestState } from "../../../src/rule-packs/nuxt/rules/nuxt/no-module-scope-request-state.ts";
import { noRequestDataInModuleState } from "../../../src/rule-packs/nuxt/rules/nuxt/no-request-data-in-module-state.ts";
import nuxtRulePack from "../../../src/rule-packs/nuxt/rules/nuxt.ts";
import { defineDoctorExtension, runDoctor } from "../../../src/core/index.ts";
import { withFixture, writeFileManifest } from "./nuxt-modern-rules-fixture.ts";

async function run(files: Record<string, string>, rules = [noRequestDataInModuleState]) {
  const result = await runProjectFixture({ framework: "nuxt", files, rules });
  return result.diagnostics
    .map((diagnostic) => ({
      code: diagnostic.code,
      file: diagnostic.file?.replace(/^.*\/(?:vue-doctor|vite-doctor-fixture)-[^/]+\//, ""),
      line: diagnostic.range?.line,
    }))
    .sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}

test.each([
  [
    "a module ref written from the route in a composable",
    "app/composables/useFilters.ts",
    `const activeFilter = ref<string | undefined>()
export function useFilters() {
  const route = useRoute()
  activeFilter.value = route.query.filter as string
  return activeFilter
}`,
  ],
  [
    "a module reactive object written from request headers in a plugin",
    "app/plugins/locale.ts",
    `import { reactive } from 'vue'
const session = reactive({ locale: 'en', token: '' })
export default defineNuxtPlugin(() => {
  const headers = useRequestHeaders(['accept-language', 'authorization'])
  session.locale = headers['accept-language'] ?? 'en'
})`,
  ],
  [
    "a plain object in a component's script block written from script setup",
    "app/components/Profile.vue",
    `<script lang="ts">
const viewer = { id: '' }
</script>
<script setup lang="ts">
const { id } = useRoute().params
viewer.id = id as string
</script>`,
  ],
  [
    "a module array filled from a cookie",
    "app/composables/useRecent.ts",
    `const recent: string[] = []
export function useRecent() {
  const last = useCookie<string>('last-viewed')
  recent.push(last.value)
}`,
  ],
  [
    "a shallowRef written from the route in route middleware",
    "app/middleware/track.global.ts",
    `const lastPath = shallowRef('')
export default defineNuxtRouteMiddleware((to) => {
  lastPath.value = to.fullPath
})`,
  ],
])("reports %s", async (_, file, source) => {
  const line = source.split("\n").findIndex((text) => /^(?:const|let) /.test(text)) + 1;
  expect(await run({ [file]: source })).toEqual([{ code: "NUXT0105", file, line }]);
});

test.each([
  [
    "useState for the same state",
    "app/composables/useFilters.ts",
    `export function useFilters() {
  const activeFilter = useState<string | undefined>('active-filter')
  activeFilter.value = useRoute().query.filter as string
  return activeFilter
}`,
  ],
  [
    "a ref created inside setup",
    "app/pages/index.vue",
    `<script setup lang="ts">
const activeFilter = ref('')
activeFilter.value = useRoute().query.filter as string
</script>`,
  ],
  [
    "writes in onMounted",
    "app/composables/useFilters.ts",
    `const activeFilter = ref('')
export function useFilters() {
  const route = useRoute()
  onMounted(() => {
    activeFilter.value = route.query.filter as string
  })
}`,
  ],
  [
    "writes behind import.meta.client",
    "app/composables/useFilters.ts",
    `const activeFilter = ref('')
export function useFilters() {
  if (import.meta.client) activeFilter.value = useRoute().query.filter as string
}`,
  ],
  [
    "client-only plugins",
    "app/plugins/locale.client.ts",
    `const session = reactive({ locale: 'en' })
export default defineNuxtPlugin(() => {
  session.locale = useRequestHeaders()['accept-language'] ?? 'en'
})`,
  ],
  [
    "client-only components",
    "app/components/Filters.client.vue",
    `<script lang="ts">
const filters = reactive({ q: '' })
</script>
<script setup lang="ts">
filters.q = useRoute().query.q as string
</script>`,
  ],
  [
    "values that do not come from the request",
    "app/composables/useTheme.ts",
    `const theme = reactive({ mode: 'light' })
export function useTheme(mode: 'light' | 'dark') {
  theme.mode = mode
}`,
  ],
  [
    "a locally declared ref helper",
    "app/composables/useFilters.ts",
    `function ref<T>(value: T) {
  return { value }
}
const activeFilter = ref('')
export function useFilters() {
  activeFilter.value = useRoute().query.filter as string
}`,
  ],
  [
    "a ref helper imported from another package",
    "app/composables/useFilters.ts",
    `import { ref } from './my-store'
const activeFilter = ref('')
export function useFilters() {
  activeFilter.value = useRoute().query.filter as string
}`,
  ],
  [
    "a route helper that is not Nuxt's",
    "app/composables/useFilters.ts",
    `import { useRoute } from './fake-router'
const activeFilter = ref('')
export function useFilters() {
  activeFilter.value = useRoute().query.filter as string
}`,
  ],
  [
    "server code, which NITRO0035 owns",
    "server/utils/filters.ts",
    `const filters = reactive({ q: '' })
export function setFilter() {
  filters.q = useRoute().query.q as string
}`,
  ],
  [
    "a click handler",
    "app/components/Filters.vue",
    `<script lang="ts">
const filters = reactive({ q: '' })
</script>
<script setup lang="ts">
const route = useRoute()
function apply() {
  filters.q = route.query.q as string
}
</script>
<template><button @click="apply">Apply</button></template>`,
  ],
])("does not report %s", async (_, file, source) => {
  expect(await run({ [file]: source })).toEqual([]);
});

test("stays quiet when the app disables server-side rendering", async () => {
  expect(
    await run({
      "nuxt.config.ts": "export default defineNuxtConfig({ ssr: false })",
      "app/composables/useFilters.ts": `const activeFilter = ref('')
export function useFilters() {
  activeFilter.value = useRoute().query.filter as string
}`,
    }),
  ).toEqual([]);
});

test("reports each case once next to NUXT0084", async () => {
  const diagnostics = await run(
    {
      "app/composables/useUser.ts": `let currentUser: unknown
const products = new Map<string, unknown>()
const filters = reactive({ q: '' })
export async function useUser(id: string) {
  currentUser = useRoute().params.id
  products.set(id, useRoute().query)
  filters.q = useRoute().query.q as string
}`,
    },
    [noRequestDataInModuleState, noModuleScopeRequestState],
  );
  expect(diagnostics).toEqual([
    { code: "NUXT0084", file: "app/composables/useUser.ts", line: 1 },
    { code: "NUXT0084", file: "app/composables/useUser.ts", line: 2 },
    { code: "NUXT0105", file: "app/composables/useUser.ts", line: 3 },
  ]);
});

test("ships in the Recommended Preset", () => {
  expect(nuxtRulePack.presets.recommended).toContain("nuxt/ssr/no-request-data-in-module-state");
});

test("a client-only reset does not hide a server write", async () => {
  const file = "app/plugins/filter.ts";
  expect(
    await run(
      {
        [file]: `let filter = ref('')
export default defineNuxtPlugin(() => {
  filter.value = useRoute().fullPath
  if (import.meta.client) filter = ref('')
})`,
      },
      [noRequestDataInModuleState, noModuleScopeRequestState],
    ),
  ).toEqual([{ code: "NUXT0105", file, line: 1 }]);
});

test("a request-derived reassignment supersedes a member write only if selected", async () => {
  const file = "app/plugins/filter.ts";
  const files = {
    [file]: `let filter = ref('')
export default defineNuxtPlugin(() => {
  filter.value = useRoute().fullPath
  filter = ref(useRoute().fullPath)
})`,
  };
  expect(await run(files)).toEqual([{ code: "NUXT0105", file, line: 1 }]);
  expect(await run(files, [noRequestDataInModuleState, noModuleScopeRequestState])).toEqual([
    { code: "NUXT0084", file, line: 1 },
  ]);
});

test("setup-local declarations shadow plain script state regardless of block order", async () => {
  const script = `<script>const filter = { value: '' }</script>`;
  const setup = `<script setup>
const filter = { value: '' }
filter.value = useRoute().fullPath
</script>`;
  expect(
    await run({ "app/pages/index.vue": script + setup, "app/pages/other.vue": setup + script }),
  ).toEqual([]);
});

test.each([
  ["namespace latest { export interface State {} }", true],
  ["namespace useRoute { export namespace Types { export type Query = string } }", true],
  ["namespace latest { export let value = '' }", false],
  ["namespace useRoute { export const local = true }", false],
])("resolves plain-script bindings with setup declaration %s", async (namespace, reports) => {
  const file = "app/pages/index.vue";
  expect(
    await run({
      [file]: `<script lang="ts">
import { useRoute } from '#app'
const latest = ref('')
</script>
<script setup lang="ts">
${namespace}
latest.value = useRoute().fullPath
</script>`,
    }),
  ).toEqual(reports ? [{ code: "NUXT0105", file, line: 3 }] : []);
});

test.each([
  ["import { ref as createRef } from 'vue'", "createRef", true],
  ["import { ref } from './project-factory'", "ref", false],
  ["const ref = () => ({ value: '' })", "ref", true],
])("resolves plain-script factories with setup binding %s", async (binding, factory, reports) => {
  const file = "app/pages/index.vue";
  const result = await run({
    [file]: `<script>
const shared = ${factory}('')
</script>
<script setup>
${binding}
shared.value = useRoute().fullPath
</script>`,
  });
  expect(result).toEqual(reports ? [{ code: "NUXT0105", file, line: 2 }] : []);
});

test("uses static-block bindings rather than outer setup constants", async () => {
  const file = "app/pages/index.vue";
  expect(
    await run(
      {
        [file]: `<script>
const latest = ref('')
let lastRoute = ''
</script>
<script setup>
const enabled = false
class Handler {
  static {
    const enabled = true
    latest.value = enabled && useRoute().fullPath
    lastRoute = enabled && useRoute().fullPath
  }
}
</script>`,
      },
      [noRequestDataInModuleState, noModuleScopeRequestState],
    ),
  ).toEqual([
    { code: "NUXT0105", file, line: 2 },
    { code: "NUXT0084", file, line: 3 },
  ]);
});

test("only SSR-running watchers can write request data during setup", async () => {
  const file = "app/pages/index.vue";
  expect(
    await run({
      [file]: `<script>
const effect = ref('')
const immediate = ref('')
const mounted = ref('')
const post = ref('')
const deferred = ref('')
</script>
<script setup>
const route = useRoute()
watchEffect(() => { effect.value = route.fullPath })
watch(() => route.fullPath, () => { immediate.value = route.fullPath }, { immediate: true })
onMounted(() => { mounted.value = route.fullPath })
watchPostEffect(() => { post.value = route.fullPath })
watch(() => route.fullPath, () => { deferred.value = route.fullPath })
onMounted(() => watchEffect(() => { mounted.value = route.fullPath }))
watchEffect(() => { post.value = route.fullPath }, { flush: 'post' })
</script>`,
    }),
  ).toEqual([
    { code: "NUXT0105", file, line: 2 },
    { code: "NUXT0105", file, line: 3 },
  ]);
});

const registry = [
  { name: "ref", as: "ref", from: "vue" },
  { name: "useRoute", as: "pageRoute", from: "#app/composables/router" },
  { name: "useRoute", as: "useRoute", from: "./app/utils/fake-router" },
  { name: "fakeRef", as: "customRef", from: "./app/utils/fake-ref" },
];

test.each([
  [
    "route-specific SSR opt-out",
    { routeRules: { "/spa/**": { ssr: false } } },
    "nuxtRoute",
    "ref",
    true,
    true,
  ],
  ["manifest auto-import alias", {}, "pageRoute", "ref", false, true],
  ["project reader exported from #imports", {}, "useRoute", "ref", true, false],
  ["project factory exported from #imports", {}, "pageRoute", "customRef", true, false],
] as const)(
  "uses manifest evidence for %s",
  async (_, extra, reader, factory, explicit, expected) => {
    const source = `<script>${explicit ? `import { ${factory}, ${reader} } from '#imports'` : ""}
const filter = ${factory}('')
</script>
<script setup>
filter.value = ${reader}().fullPath
</script>`;
    await withFixture({ "app/pages/index.vue": source }, {}, async (root) => {
      await writeFileManifest(root, [], {
        srcDir: "app",
        generatedAt: new Date().toISOString(),
        autoImportEnabled: true,
        autoImports: [
          ...registry,
          { name: "useRoute", as: "nuxtRoute", from: "#app/composables/router" },
        ],
        ...extra,
      });
      const result = await runDoctor({
        root,
        framework: "nuxt",
        extensions: [defineDoctorExtension({ name: "fixture", rulePacks: [nuxtRulePack] })],
        rules: noRequestDataInModuleState.meta.id,
        cache: false,
      });
      expect(result.project.nuxt?.autoImportsAuthoritative).toBe(true);
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
        expected ? ["NUXT0105"] : [],
      );
    });
  },
);

test("recommends keeping server-only request data out of hydration state", async () => {
  const result = await runProjectFixture({
    framework: "nuxt",
    rules: [noRequestDataInModuleState],
    files: {
      "app/composables/useAuth.ts": `const auth = ref('')
export function useAuth() {
  if (import.meta.server) auth.value = useRequestHeader('authorization')
}`,
    },
  });
  expect(result.diagnostics[0]?.suggestion).toMatch(
    /server-only.*useState.*hydration.*safe to send/i,
  );
});
