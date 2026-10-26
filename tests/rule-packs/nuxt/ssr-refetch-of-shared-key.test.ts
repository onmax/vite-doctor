import { describe, expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { noSsrRefetchOfSharedKey } from "../../../src/rule-packs/nuxt/rules/nuxt/no-ssr-refetch-of-shared-key.ts";

const useMe = `export function useMe() {
  return useFetch('/api/me', { key: 'me' })
}`;

const middleware = `export default defineNuxtRouteMiddleware(async (to) => {
  const { data: me } = await useMe()
  if (!me.value) return navigateTo('/signin')
})`;

const layout = `<script setup lang="ts">
const { data: me } = await useMe()
</script>
<template><div><slot /></div></template>`;

const component = `<script setup lang="ts">
const { data: me } = useMe()
</script>
<template><span>{{ me }}</span></template>`;

// The shape vite-hub/drop shipped before #61: a request-local createUseFetch factory and a keyed
// viewer composable, called from a page's inline middleware and from the page itself.
const dropApi = `export const useApi = createUseFetch(() => {
  if (import.meta.client) return {}
  return { headers: useRequestHeaders(['cookie']) }
})

export function useMe() {
  return useApi('/api/me', { key: keys.me, default: () => null })
}`;

const dropPage = `<script setup lang="ts">
definePageMeta({
  middleware: async (to) => {
    const { data: me } = await useMe()
    if (me.value) setPageLayout('dashboard')
  },
})
const { data: me } = await useMe()
</script>
<template><div>{{ me }}</div></template>`;

async function run(files: Record<string, string>) {
  const result = await runRuleFixture({
    rule: noSsrRefetchOfSharedKey,
    framework: "nuxt",
    files,
  });
  return result.diagnostics;
}

describe("nuxt/fetch/no-ssr-refetch-of-shared-key", () => {
  test("reports a keyed composable called from middleware, a layout, and a component", async () => {
    const diagnostics = await run({
      "app/composables/useMe.ts": useMe,
      "app/middleware/auth.global.ts": middleware,
      "app/layouts/default.vue": layout,
      "app/components/UserMenu.vue": component,
      "app/pages/index.vue": "<template><UserMenu /></template>",
    });

    expect(diagnostics).toHaveLength(1);
    const [diagnostic] = diagnostics;
    expect(diagnostic?.code).toBe("NUXT0095");
    expect(diagnostic?.severity).toBe("warn");
    expect(diagnostic?.file).toMatch(/app\/composables\/useMe\.ts$/);
    expect(diagnostic?.range?.line).toBe(2);
    expect(diagnostic?.why).toContain("useMe()");
    expect(diagnostic?.why).toContain("'me'");
    expect(diagnostic?.why).toContain("dedupe: 'cancel'");
    expect(diagnostic?.suggestion).toContain("dedupe: 'defer'");
    expect(diagnostic?.suggestion).toContain("ctx.cause === 'initial'");
    expect(diagnostic?.suggestion).toContain("import.meta.server");
    expect(diagnostic?.related?.map((item) => item.file.replace(/^.*\/app\//, ""))).toEqual([
      "middleware/auth.global.ts",
      "layouts/default.vue",
      "components/UserMenu.vue",
    ]);
    expect(diagnostic?.evidence?.map((item) => item.summary).join("\n")).toContain(
      "runs on every server render",
    );
  });

  test("reports the drop factory composable from a page's inline middleware and setup", async () => {
    const diagnostics = await run({
      "app/composables/useApi.ts": dropApi,
      "app/utils/keys.ts": "export const keys = { me: 'me' }",
      "app/pages/d/[id].vue": dropPage,
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.file).toMatch(/app\/composables\/useApi\.ts$/);
    expect(diagnostics[0]?.why).toContain("keys.me");
    expect(diagnostics[0]?.why).toContain("inline page middleware");
    expect(diagnostics[0]?.suggestion).toContain("defaults.dedupe ?? 'defer'");
    expect(diagnostics[0]?.suggestion).toContain("defaults.getCachedData ??");
    expect(diagnostics[0]?.related).toHaveLength(2);
  });

  test("accepts the drop#61 factory that defers and reuses initial payload data", async () => {
    const fixed = `export const useApi = createUseFetch((defaults) => {
  if (import.meta.client) return {}
  return {
    dedupe: defaults.dedupe ?? 'defer',
    getCachedData:
      defaults.getCachedData ??
      ((key, nuxtApp, context) => (context.cause === 'initial' ? nuxtApp.payload.data[key] : undefined)),
    headers: useRequestHeaders(['cookie']),
  }
})

export function useMe() {
  return useApi('/api/me', { key: keys.me, default: () => null })
}`;
    expect(
      await run({
        "app/composables/useApi.ts": fixed,
        "app/utils/keys.ts": "export const keys = { me: 'me' }",
        "app/pages/d/[id].vue": dropPage,
      }),
    ).toEqual([]);
  });

  test.each([
    [
      "server-only shared options",
      `export function useMe() {
  return useFetch('/api/me', {
    key: 'me',
    ...(import.meta.server && {
      dedupe: 'defer',
      getCachedData: (key, nuxtApp, ctx) => (ctx.cause === 'initial' ? nuxtApp.payload.data[key] : undefined),
    }),
  })
}`,
    ],
    [
      "a cause-aware getCachedData",
      `export function useMe() {
  return useFetch('/api/me', {
    key: 'me',
    dedupe: 'defer',
    getCachedData: (key, nuxtApp, ctx) => (ctx.cause === 'initial' ? nuxtApp.payload.data[key] : undefined),
  })
}`,
    ],
    [
      "server: false",
      "export const useMe = () => useFetch('/api/me', { key: 'me', server: false })",
    ],
    [
      "immediate: false",
      "export const useMe = () => useFetch('/api/me', { key: 'me', immediate: false })",
    ],
    [
      "a dynamic enabled flag",
      "export const useMe = () => useFetch('/api/me', { key: 'me', enabled: useSignedIn() })",
    ],
  ])("accepts %s", async (_name, composable) => {
    expect(
      await run({
        "app/composables/useMe.ts": composable,
        "app/middleware/auth.global.ts": middleware,
        "app/layouts/default.vue": layout,
      }),
    ).toEqual([]);
  });

  test("still reports dedupe: 'defer' without getCachedData", async () => {
    const diagnostics = await run({
      "app/composables/useMe.ts":
        "export const useMe = () => useFetch('/api/me', { key: 'me', dedupe: 'defer' })",
      "app/middleware/auth.global.ts": middleware,
      "app/layouts/default.vue": layout,
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.why).toContain("only shares a request that is still in flight");
    expect(diagnostics[0]?.suggestion).not.toContain("dedupe: 'defer'");
    expect(diagnostics[0]?.suggestion).toContain("getCachedData");
  });

  test("reports useLazyFetch, which still fetches during SSR", async () => {
    const diagnostics = await run({
      "app/composables/useMe.ts": "export const useMe = () => useLazyFetch('/api/me')",
      "app/app.vue": layout.replace("<slot />", "<NuxtPage />"),
      "app/pages/index.vue": component,
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.why).toContain("the key Nuxt generates for useLazyFetch() here");
  });

  test("ignores a composable with a single call site", async () => {
    expect(
      await run({
        "app/composables/useMe.ts": useMe,
        "app/layouts/default.vue": layout,
        "app/pages/index.vue": "<template><div /></template>",
      }),
    ).toEqual([]);
  });

  test("ignores callers that only run on the client", async () => {
    expect(
      await run({
        "app/composables/useMe.ts": useMe,
        "app/middleware/auth.global.ts": `export default defineNuxtRouteMiddleware(async () => {
  if (import.meta.client) {
    await useMe()
  }
})`,
        "app/plugins/viewer.client.ts": "export default defineNuxtPlugin(() => { useMe() })",
        "app/components/Avatar.client.vue": component,
        "app/components/Menu.vue": `<script setup lang="ts">
onMounted(() => useMe())
const load = () => useMe()
</script>
<template><button @click="load" /></template>`,
        "app/layouts/default.vue": layout,
      }),
    ).toEqual([]);
  });

  test("ignores calls after a server early return", async () => {
    expect(
      await run({
        "app/composables/useMe.ts": useMe,
        "app/middleware/auth.global.ts": `export default defineNuxtRouteMiddleware(async () => {
  if (import.meta.server) return
  await useMe()
})`,
        "app/layouts/default.vue": layout,
      }),
    ).toEqual([]);
  });

  test("ignores composables whose key depends on their arguments", async () => {
    expect(
      await run({
        "app/composables/useUser.ts":
          "export const useUser = (id: string) => useFetch(`/api/users/${id}`, { key: `user-${id}` })",
        "app/middleware/auth.global.ts":
          "export default defineNuxtRouteMiddleware(async (to) => { await useUser(String(to.params.id)) })",
        "app/layouts/default.vue": `<script setup lang="ts">
await useUser('me')
</script>`,
      }),
    ).toEqual([]);
  });

  test("groups direct calls by their literal key", async () => {
    const distinct = await run({
      "app/middleware/auth.global.ts":
        "export default defineNuxtRouteMiddleware(async () => { await useFetch('/api/me', { key: 'me' }) })",
      "app/layouts/default.vue": `<script setup lang="ts">
await useFetch('/api/teams', { key: 'teams' })
</script>`,
    });
    expect(distinct).toEqual([]);

    const shared = await run({
      "app/middleware/auth.global.ts":
        "export default defineNuxtRouteMiddleware(async () => { await useFetch('/api/me', { key: 'me' }) })",
      "app/layouts/default.vue": `<script setup lang="ts">
await useAsyncData('me', () => $fetch('/api/me'))
</script>`,
    });
    expect(shared).toHaveLength(1);
    expect(shared[0]?.file).toMatch(/middleware\/auth\.global\.ts$/);
  });

  test("ignores two pages, which never render together", async () => {
    expect(
      await run({
        "app/composables/useMe.ts": useMe,
        "app/pages/index.vue": layout,
        "app/pages/account.vue": layout,
      }),
    ).toEqual([]);
  });

  test("pairs a page with the named middleware it declares", async () => {
    const page = `<script setup lang="ts">
definePageMeta({ middleware: ['auth'] })
const { data: me } = await useMe()
</script>`;
    const files = {
      "app/composables/useMe.ts": useMe,
      "app/middleware/auth.ts": middleware,
      "app/pages/account.vue": page,
    };
    expect(await run(files)).toHaveLength(1);
    expect(
      await run({ ...files, "app/pages/account.vue": page.replace("['auth']", "['other']") }),
    ).toEqual([]);
  });

  test("pairs a page with its layout only while layouts are static", async () => {
    const files = {
      "app/composables/useMe.ts": useMe,
      "app/layouts/default.vue": layout,
      "app/pages/index.vue": component,
    };
    expect(await run(files)).toHaveLength(1);
    expect(
      await run({
        ...files,
        "app/pages/index.vue": `<script setup lang="ts">
definePageMeta({ layout: false })
const { data: me } = useMe()
</script>`,
      }),
    ).toEqual([]);
    expect(
      await run({
        ...files,
        "app/middleware/layout.global.ts":
          "export default defineNuxtRouteMiddleware(() => { setPageLayout('wide') })",
      }),
    ).toEqual([]);
    expect(
      await run({
        ...files,
        "app/app.vue": "<template><NuxtPage /></template>",
      }),
    ).toEqual([]);
  });

  test("pairs a page with the components it renders, but not inside ClientOnly", async () => {
    const page = (template: string) => `<script setup lang="ts">
import UserMenu from '~/components/UserMenu.vue'
const { data: me } = await useMe()
</script>
<template>${template}</template>`;
    const files = {
      "app/composables/useMe.ts": useMe,
      "app/components/UserMenu.vue": component,
    };
    const rendered = await run({ ...files, "app/pages/index.vue": page("<UserMenu />") });
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.evidence?.map((item) => item.summary).join("\n")).toContain(
      "pages/index.vue",
    );
    expect(
      await run({ ...files, "app/pages/index.vue": page("<ClientOnly><UserMenu /></ClientOnly>") }),
    ).toEqual([]);
  });

  test("follows auto-imported components through Nuxt's directory naming", async () => {
    const diagnostics = await run({
      "app/composables/useMe.ts": useMe,
      "app/layouts/default.vue": `<script setup lang="ts">
const { data: me } = await useMe()
</script>
<template><div><ViewerSidebar /><slot /></div></template>`,
      "app/components/viewer/ViewerSidebar.vue": "<template><nav><LazyBaseRow /></nav></template>",
      "app/components/base/Row.vue": component,
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.related?.map((item) => item.file.replace(/^.*\/app\//, ""))).toEqual([
      "layouts/default.vue",
      "components/base/Row.vue",
    ]);
  });

  test("ignores composables in an SPA", async () => {
    expect(
      await run({
        "nuxt.config.ts": "export default defineNuxtConfig({ ssr: false })",
        "app/composables/useMe.ts": useMe,
        "app/middleware/auth.global.ts": middleware,
        "app/layouts/default.vue": layout,
      }),
    ).toEqual([]);
  });
});
