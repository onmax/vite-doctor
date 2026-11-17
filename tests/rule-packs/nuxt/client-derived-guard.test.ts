import { expect, test } from "vite-plus/test";
import {
  noBrowserGlobalInUniversalCode,
  preferUseCookieForInitialClientState,
} from "../../../src/rule-packs/nuxt/rules/nuxt.ts";
import { runRuleFixture } from "../../../src/core/testkit.ts";

async function storageDiagnostics(files: Record<string, string>) {
  const [browser, cookie] = await Promise.all([
    runRuleFixture({ rule: noBrowserGlobalInUniversalCode, framework: "nuxt", files }),
    runRuleFixture({ rule: preferUseCookieForInitialClientState, framework: "nuxt", files }),
  ]);
  return [...browser.diagnostics, ...cookie.diagnostics].map((item) => item.ruleId).sort();
}

const columnState = (
  storageKey: string,
) => `export function useGridColumnState({ stateKey }: { stateKey: MaybeRefOrGetter<string | undefined> }) {
  const userSession = useUserSession()
  const storageKey = computed(() => {
    const key = toValue(stateKey)
    ${storageKey}
  })

  function read(key: string) {
    let layout = null
    try {
      layout = JSON.parse(localStorage.getItem(key) ?? '{}')
    }
    catch {}
    return layout ?? {}
  }

  const customized = shallowRef(false)
  watch(storageKey, key => customized.value = Boolean(key && Object.keys(read(key)).length), { immediate: true })

  const resolved = computed(() => {
    const layout = storageKey.value ? read(storageKey.value) : {}
    return { layout }
  })

  function hasSavedWidth(colId: string) {
    return Boolean(storageKey.value && read(storageKey.value)[colId])
  }

  return { layout: computed(() => resolved.value.layout), hasSavedWidth }
}
`;

test("storage reads behind a computed that is empty on the server are not reported", async () => {
  expect(
    await storageDiagnostics({
      "app/composables/useGridColumnState.ts": columnState(
        "return import.meta.client && key ? `grid-columns:${userSession.user.value?.id ?? ''}:${key}` : undefined",
      ),
    }),
  ).toEqual([]);
});

test("client-derived guards accept the common shapes of a server-empty value", async () => {
  expect(
    await storageDiagnostics({
      "app/composables/useArrowKey.ts": `export function useArrowKey(name: string) {
  const key = computed(() => import.meta.client ? name : null)
  const saved = computed(() => key.value ? localStorage.getItem(key.value) : null)
  return { saved }
}`,
      "app/composables/useInlineGuard.ts": `export function useInlineGuard() {
  const saved = computed(() => import.meta.client && localStorage.getItem('theme'))
  return { saved }
}`,
      "app/composables/useConstFlag.ts": `export function useConstFlag(name: string) {
  const enabled = import.meta.client && name.length > 0
  const saved = computed(() => {
    if (enabled) return localStorage.getItem(name)
    return null
  })
  return { saved }
}`,
      "app/composables/useBlockKey.ts": `export function useBlockKey(name: Ref<string>) {
  const key = computed(() => {
    if (!import.meta.client) return undefined
    return name.value
  })
  const saved = computed(() => key.value && localStorage.getItem(key.value))
  return { saved }
}`,
    }),
  ).toEqual([]);
});

test("storage reads behind a computed the server can fill are still reported", async () => {
  expect(
    await storageDiagnostics({
      "app/composables/useGridColumnState.ts": columnState(
        "return key ? `grid-columns:${userSession.user.value?.id ?? ''}:${key}` : undefined",
      ),
    }),
  ).toEqual([
    "nuxt/hydration/no-browser-global-in-universal-code",
    "nuxt/hydration/prefer-usecookie-for-initial-client-state",
  ]);
  expect(
    await storageDiagnostics({
      "app/composables/useMixedKey.ts": `export function useMixedKey(name: Ref<string>) {
  const key = computed(() => {
    if (name.value === 'server') return name.value
    return import.meta.client ? name.value : undefined
  })
  const label = computed(() => \`\${name.value} settings\`)
  const saved = computed(() => key.value ? localStorage.getItem(key.value) : null)
  return { label, saved }
}`,
      "app/composables/useLetFlag.ts": `export function useLetFlag(name: string) {
  let enabled = import.meta.client
  const label = computed(() => \`\${name} settings\`)
  enabled = true
  const saved = computed(() => enabled ? localStorage.getItem(name) : null)
  return { label, saved }
}`,
    }),
  ).toEqual([
    "nuxt/hydration/no-browser-global-in-universal-code",
    "nuxt/hydration/no-browser-global-in-universal-code",
    "nuxt/hydration/prefer-usecookie-for-initial-client-state",
    "nuxt/hydration/prefer-usecookie-for-initial-client-state",
  ]);
});

test("unguarded top-level storage reads in setup are still reported", async () => {
  expect(
    await storageDiagnostics({
      "app/pages/index.vue": `<script setup lang="ts">
const theme = localStorage.getItem('theme')
const clientKey = computed(() => import.meta.client ? 'theme' : undefined)
</script>`,
    }),
  ).toEqual([
    "nuxt/hydration/no-browser-global-in-universal-code",
    "nuxt/hydration/prefer-usecookie-for-initial-client-state",
  ]);
});

const storageRuleIds = [
  "nuxt/hydration/no-browser-global-in-universal-code",
  "nuxt/hydration/prefer-usecookie-for-initial-client-state",
];

for (const [name, prelude, guard] of [
  [
    "local computed wrapper",
    `import { computed as vueComputed } from 'vue'
function computed(getter: () => unknown) { return vueComputed(() => getter() ?? 'theme') }`,
    `const key = computed(() => import.meta.client ? 'theme' : undefined)`,
  ],
  [
    "unrelated imported computed",
    `import { computed } from './other'`,
    `const key = computed(() => import.meta.client ? 'theme' : undefined)`,
  ],
  [
    "parameter computed",
    ``,
    `const key = computed(() => import.meta.client ? 'theme' : undefined)`,
  ],
] as const) {
  test(`${name} does not prove a server-empty getter`, async () => {
    expect(
      await storageDiagnostics({
        "app/composables/useProbe.ts": `${prelude}
export function useProbe(${name === "parameter computed" ? "computed: Function" : ""}) {
  ${guard}
  const label = 'This separates the source of the guard from the storage access sufficiently'
  const saved = key.value ? localStorage.getItem(key.value) : null
  return { label, saved }
}`,
      }),
    ).toEqual(storageRuleIds);
  });
}

for (const guard of [
  "if (process.server) return",
  "const enabled = process.client; if (!enabled) return",
]) {
  test(`shadowed process remains unknown: ${guard}`, async () => {
    expect(
      await storageDiagnostics({
        "app/composables/useProbe.ts": `export function useProbe(process: { server: boolean, client: boolean }) {
  ${guard}
  const label = 'This separates the source of the guard from the storage access sufficiently'
  const saved = localStorage.getItem('theme')
  return { label, saved }
}`,
      }),
    ).toEqual(storageRuleIds);
  });
}

for (const [prelude, expression] of [
  [
    "import { computed as vueComputed } from 'vue'",
    "vueComputed(() => import.meta.client ? 'theme' : undefined)",
  ],
  ["import * as Vue from 'vue'", "Vue.computed(() => import.meta.client ? 'theme' : undefined)"],
  ["", "computed(() => (client && first) || (client && second))"],
  ["", "computed(() => first ? clientKey : clientKey)"],
] as const) {
  test(`server-empty proof accepts ${expression}`, async () => {
    expect(
      await storageDiagnostics({
        "app/composables/useProbe.ts": `${prelude}
export function useProbe(first: string, second: string) {
  const client = import.meta.client
  const clientKey = client && first
  const key = ${expression}
  const label = 'This separates the source of the guard from the storage access sufficiently'
  const saved = key.value ? localStorage.getItem(key.value) : null
  return { label, saved }
}`,
      }),
    ).toEqual([]);
  });
}

test("cyclic immutable guards terminate without proving safety", async () => {
  expect(
    await storageDiagnostics({
      "app/composables/useProbe.ts": `export function useProbe() {
  const first = second
  const second = first
  const saved = first ? localStorage.getItem('theme') : null
  return { saved }
}`,
    }),
  ).toEqual(storageRuleIds);
});
