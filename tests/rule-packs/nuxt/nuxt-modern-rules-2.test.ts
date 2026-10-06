import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { defineDoctorExtension, defineRulePack, runDoctor } from "../../../src/core/index.ts";
import { vueRulePack } from "../../../src/rule-packs/vue/rules.ts";
import nuxtContentRulePack from "../../../src/rule-packs/nuxt/rules/nuxt-content.ts";
import docusRulePack from "../../../src/rule-packs/nuxt/rules/docus.ts";
import { preferUButton, preferUFormControls } from "../../../src/rule-packs/nuxt/rules/nuxt-ui.ts";
import {
  noBrowserGlobalInUniversalCode,
  noBrowserSideEffectsInSetup,
  noNestedAutoimportAssumption,
  noNestedSharedAutoimportAssumption,
  noSubdirPluginAutoRegistrationAssumption,
  noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
  noRouteMiddlewareApiSecurity,
  noComposableAfterAwait,
  noPlainEnvInAppCode,
  preferUseCookieForInitialClientState,
  noNonSerializableUseState,
  noExplicitAutoImport,
} from "../../../src/rule-packs/nuxt/rules/nuxt.ts";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import nuxtDoctorModule, { writeManifest } from "../../../src/rule-packs/nuxt/module.ts";
import { createTextReport } from "../../../src/core/index.ts";
import { nuxtDoctorExtensions } from "../../../src/rule-packs/nuxt/rules/index.ts";
import {
  preferUseEventListener,
  preferUseObservers,
  preferUseScrollAndElement,
  preferUseStorage,
  preferUseTimers,
} from "../../../src/rule-packs/nuxt/rules/vueuse.ts";
import { withFixture, writeFileManifest } from "./nuxt-modern-rules-fixture.ts";

test("client-only useState non-serializable values are ignored while SSR state reports", async () => {
  const client = await runRuleFixture({
    rule: noNonSerializableUseState,
    framework: "nuxt",
    files: {
      "app/plugins/visited.client.ts": `export default defineNuxtPlugin(() => useState('visited', () => new WebSocket('wss://example.com')))`,
    },
  });
  const universal = await runRuleFixture({
    rule: noNonSerializableUseState,
    framework: "nuxt",
    files: {
      "app/composables/useVisited.ts": `export function useVisited() { return useState('visited', () => new WebSocket('wss://example.com')) }`,
    },
  });

  expect(client.diagnostics).toHaveLength(0);
  expect(universal.diagnostics[0]?.ruleId).toBe("nuxt/state/no-nonserializable-usestate");
});

test("useState allows factory-local Date values converted to strings", async () => {
  const result = await runRuleFixture({
    rule: noNonSerializableUseState,
    framework: "nuxt",
    files: {
      "app/composables/useDateRange.ts": `export function useDateRange() {
  return useState('date-range', () => {
    const end = new Date()
    return {
      start: subDays(end, 30).toISOString(),
      end: end.toISOString()
    }
  })
}`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("useState still reports returned live sockets", async () => {
  const result = await runRuleFixture({
    rule: noNonSerializableUseState,
    framework: "nuxt",
    files: {
      "app/composables/useSocketState.ts": `export function useSocketState() {
  return useState('socket-state', () => ({ socket: new WebSocket('wss://example.com') }))
}`,
    },
  });

  expect(result.diagnostics[0]?.ruleId).toBe("nuxt/state/no-nonserializable-usestate");
  expect(result.diagnostics[0]?.sources).toBeUndefined();
  expect(createTextReport(result)).not.toContain("sources: https://nuxt.com/docs");
});

test("Vue lifecycle evidence skips Nuxt content, server, generated, and client-only files", async () => {
  await withFixture(
    {
      "content/demo.md": `setInterval(() => {}, 1000)`,
      "server/api/events.ts": `export default defineEventHandler(() => setInterval(() => {}, 1000))`,
      "shared/types/lexicons/generated.ts": `// @generated\nnew IntersectionObserver(() => {})`,
      "app/plugins/view.client.ts": `setInterval(() => {}, 1000)`,
      "app/components/Leaky.vue": `<script setup>setInterval(() => {}, 1000)</script>`,
    },
    {},
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "nuxt",
        extensions: [defineDoctorExtension({ name: "vue", rulePacks: [vueRulePack] })],
      });

      expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
        "vue/lifecycle/require-cleanup",
      ]);
      expect(result.diagnostics[0]?.file).toContain("app/components/Leaky.vue");
    },
  );
});

test("Nuxt UI button rule reports native buttons", async () => {
  const result = await runRuleFixture({
    rule: preferUButton,
    framework: "nuxt",
    files: {
      "app/pages/index.vue": `<template><button type="button" @click="copy()">Copy</button></template>`,
    },
  });

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.ruleId).toBe("nuxt-ui/prefer-u-button");
  expect(result.diagnostics[0]?.suggestion).toContain("<UButton>");
});

test("Nuxt UI button rule ignores UButton and explicit doctor ignores", async () => {
  const result = await runRuleFixture({
    rule: preferUButton,
    framework: "nuxt",
    files: {
      "app/pages/index.vue": `<template>
<UButton @click="copy()">Copy</UButton>
<button data-doctor-ignore type="button">Native</button>
</template>`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("Nuxt UI form controls rule reports clear native form control replacements", async () => {
  const result = await runRuleFixture({
    rule: preferUFormControls,
    framework: "nuxt",
    files: {
      "app/pages/index.vue": `<template>
<input type="email" v-model="email">
<textarea v-model="body" />
<select v-model="value"><option value="a">A</option></select>
</template>`,
    },
  });

  expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
    "nuxt-ui/prefer-u-form-controls",
    "nuxt-ui/prefer-u-form-controls",
    "nuxt-ui/prefer-u-form-controls",
  ]);
  expect(result.diagnostics.map((item) => item.suggestion)).toEqual([
    expect.stringContaining("<UInput>"),
    expect.stringContaining("<UTextarea>"),
    expect.stringContaining("<USelect>"),
  ]);
});

test("Nuxt UI form controls rule ignores ambiguous native inputs and layout elements", async () => {
  const result = await runRuleFixture({
    rule: preferUFormControls,
    framework: "nuxt",
    files: {
      "app/pages/index.vue": `<template>
<div>
  <form>
    <label>Email</label>
    <input type="checkbox">
    <input type="file">
    <input type="hidden">
    <input :type="dynamicType">
  </form>
</div>
</template>`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("browser globals inside client-only callbacks are not reported", async () => {
  const files = {
    "app/app.vue": `<script setup lang="ts">
onKeyDown('/', e => {
  const searchInput = document.querySelector<HTMLInputElement>('input[type="search"]')
  searchInput?.focus()
})

if (import.meta.client) {
  useEventListener(document, 'click', () => {})
}
</script>`,
    "app/components/Brand/Customize.vue": `<script setup lang="ts">
async function downloadCustomPng() {
  await document.fonts.ready
  const canvas = document.createElement('canvas')
}
</script>
<template><button @click="downloadCustomPng">Download</button></template>`,
    "app/components/CallToAction.vue": `<script setup lang="ts">
function handleCardClick(event: MouseEvent) {
  const selection = window.getSelection()
  if (selection?.type === 'Range') return
}
</script>
<template><article @click="handleCardClick" /></template>`,
    "app/components/CollapsibleSection.vue": `<script setup lang="ts">
onPrehydrate(() => {
  const settings = JSON.parse(localStorage.getItem('npmx-settings') || '{}')
  document.documentElement.dataset.collapsed = settings.collapsed
})

onMounted(() => {
  document.documentElement.dataset.ready = 'true'
})
</script>`,
  };

  const result = await runRuleFixture({
    rule: noBrowserGlobalInUniversalCode,
    framework: "nuxt",
    files,
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("browser side effects and storage reads inside client-only callbacks are not reported", async () => {
  const files = {
    "app/components/ClientOnlyWork.vue": `<script setup lang="ts">
onMounted(() => {
  localStorage.setItem('theme', 'dark')
})

onPrehydrate(() => {
  const theme = localStorage.getItem('theme')
  document.documentElement.dataset.theme = theme || 'system'
})
</script>`,
  };

  const sideEffects = await runRuleFixture({
    rule: noBrowserSideEffectsInSetup,
    framework: "nuxt",
    files,
  });
  const storage = await runRuleFixture({
    rule: preferUseCookieForInitialClientState,
    framework: "nuxt",
    files,
  });

  expect(sideEffects.diagnostics).toHaveLength(0);
  expect(storage.diagnostics).toHaveLength(0);
});

test("top-level browser globals report while unrendered time setup values are ignored", async () => {
  const browser = await runRuleFixture({
    rule: noBrowserGlobalInUniversalCode,
    framework: "nuxt",
    files: {
      "app/pages/index.vue": `<script setup lang="ts">
const width = window.innerWidth
const title = document.title
const theme = localStorage.getItem('theme')
</script>`,
    },
  });
  const storage = await runRuleFixture({
    rule: preferUseCookieForInitialClientState,
    framework: "nuxt",
    files: {
      "app/pages/index.vue": `<script setup lang="ts">const theme = localStorage.getItem('theme')</script>`,
    },
  });
  const time = await runRuleFixture({
    rule: noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    framework: "nuxt",
    files: {
      "app/pages/index.vue": `<script setup lang="ts">
const now = Date.now()
const id = Math.random()
const date = new Date()
</script>`,
    },
  });

  expect(browser.diagnostics.map((item) => item.ruleId)).toContain(
    "nuxt/hydration/no-browser-global-in-universal-code",
  );
  expect(storage.diagnostics).toHaveLength(1);
  expect(time.diagnostics).toHaveLength(0);
});

test("type-only, server, and client callback contexts do not create hydration noise", async () => {
  const browser = await runRuleFixture({
    rule: noBrowserGlobalInUniversalCode,
    framework: "nuxt",
    files: {
      "app/types/index.d.ts": `export interface User { location: string }`,
      "app/pages/customers.vue": `<script setup lang="ts">
const items = [{
  label: 'Copy',
  onSelect() {
    navigator.clipboard.writeText('id')
  }
}]
const columns = [{
  accessorKey: 'location',
  cell: ({ row }) => row.original.location
}]
</script>`,
      "shared/utils/tools/weather.ts": `const weatherTool = {
  execute: async ({ location }: { location: string }) => ({ location })
}`,
      "app/components/Observed.vue": `<script setup lang="ts">
const target = useTemplateRef('target')
useIntersectionObserver(target, () => {
  const observer = new IntersectionObserver(() => {})
})
useResizeObserver(target, () => {
  const width = window.innerWidth
})
onMounted(() => {
  function resize() {
    const dpr = window.devicePixelRatio
  }
  resize()
})
</script>`,
      "app/composables/useFilters.ts": `<script setup lang="ts">
const rows = [{ location: { key: 'us' } }]
const locations = computed(() => rows
  .map(row => row.location)
  .filter((location): location is { key: string } => location !== null)
  .map((location) => location.key))
</script>`,
      "app/components/ThemePicker.vue": `<script setup lang="ts">
const theme = computed({
  get() {
    return 'dark'
  },
  set(value) {
    window.localStorage.setItem('theme', value)
  }
})
</script>`,
      "app/pages/article.vue": `<script setup lang="ts">
defineShortcuts({
  meta_k: {
    handler: () => {
      navigator.clipboard.writeText(window.location.href)
    }
  }
})
</script>`,
      "app/utils/browser.ts": `export function isBrowser() {
  return typeof window !== 'undefined' && typeof document !== 'undefined'
}

export function sendWhenHidden() {
  if (isBrowser() && document.visibilityState === 'hidden') {
    navigator.sendBeacon('/log', 'ok')
  }
}`,
    },
  });
  const time = await runRuleFixture({
    rule: noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    framework: "nuxt",
    files: {
      "server/api/mails.ts": `export default defineEventHandler(() => ({ id: Date.now() }))`,
      "app/pages/index.vue": `<script setup lang="ts">const now = Date.now()</script>`,
    },
  });

  expect(browser.diagnostics).toHaveLength(0);
  expect(time.diagnostics).toHaveLength(0);
});

test("Nuxt runtime rules skip content, config, generated, client-only, and external package noise", async () => {
  const markdownMiddleware = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "content/blog/release.md":
        "```ts [middleware/auth.ts]\nexport default defineNuxtRouteMiddleware(() => navigateTo('/login'))\n```",
      "server/api/private.get.ts": `export default defineEventHandler(() => ({ ok: true }))`,
    },
  });
  const env = await runRuleFixture({
    rule: noPlainEnvInAppCode,
    framework: "nuxt",
    files: {
      "content.config.ts": `export default { source: process.env.CONTENT_SOURCE }`,
      "config/env.ts": `export const isPr = Boolean(process.env.PULL_REQUEST)`,
      "cli/src/cli.ts": `if (process.env.DEBUG) process.exit(0)`,
      "app/pages/index.vue": `<script setup lang="ts">const key = process.env.API_KEY</script>`,
    },
  });
  const generatedShared = await runRuleFixture({
    rule: noNestedSharedAutoimportAssumption,
    framework: "nuxt",
    files: {
      "shared/types/lexicons/app/bsky/actor.ts": `// @generated\nexport interface Actor { did: string }`,
      "shared/utils/nested/math.ts": `export const one = 1`,
    },
  });
  const clientAwait = await runRuleFixture({
    rule: noComposableAfterAwait,
    framework: "nuxt",
    files: {
      "app/components/CommandPalette.client.vue": `<script setup lang="ts">
async function handleSelect(to: string) {
  await close()
  await navigateTo(to)
}
</script>`,
      "app/pages/index.vue": `<script setup lang="ts">await foo(); useRuntimeConfig()</script>`,
    },
  });

  expect(markdownMiddleware.diagnostics).toHaveLength(0);
  expect(env.diagnostics.map((item) => item.file)).toHaveLength(1);
  expect(env.diagnostics[0]?.file).toContain("app/pages/index.vue");
  expect(generatedShared.diagnostics.map((item) => item.file)).toHaveLength(1);
  expect(generatedShared.diagnostics[0]?.file).toContain("shared/utils/nested/math.ts");
  expect(clientAwait.diagnostics).toHaveLength(0);
});

test("VueUse preference rules suggest composables for raw browser APIs", async () => {
  const timers = await runRuleFixture({
    rule: preferUseTimers,
    framework: "nuxt",
    files: {
      "app/components/Panel.vue": `<script setup lang="ts">
setTimeout(() => {}, 100)
window.setInterval(() => {}, 1000)
requestAnimationFrame(() => {})
</script>`,
    },
  });
  const observers = await runRuleFixture({
    rule: preferUseObservers,
    framework: "nuxt",
    files: {
      "app/components/Panel.vue": `<script setup lang="ts">
new IntersectionObserver(() => {})
new ResizeObserver(() => {})
new MutationObserver(() => {})
</script>`,
    },
  });
  const events = await runRuleFixture({
    rule: preferUseEventListener,
    framework: "nuxt",
    files: {
      "app/components/Panel.vue": `<script setup lang="ts">
window.addEventListener('resize', () => {})
document.addEventListener('click', () => {})
addEventListener('online', () => {})
</script>`,
    },
  });
  const storage = await runRuleFixture({
    rule: preferUseStorage,
    framework: "nuxt",
    files: {
      "app/components/Panel.vue": `<script setup lang="ts">
localStorage.getItem('theme')
sessionStorage.setItem('tab', 'one')
</script>`,
    },
  });
  const scroll = await runRuleFixture({
    rule: preferUseScrollAndElement,
    framework: "nuxt",
    files: {
      "app/components/Panel.vue": `<script setup lang="ts">
const y = window.scrollY
window.scrollTo(0, 100)
target.value?.getBoundingClientRect()
</script>`,
    },
  });

  expect(timers.diagnostics.map((item) => item.suggestion)).toEqual([
    "Use VueUse useTimeoutFn() for lifecycle-aware timing.",
    "Use VueUse useIntervalFn() for lifecycle-aware timing.",
    "Use VueUse useRafFn() for lifecycle-aware timing.",
  ]);
  expect(observers.diagnostics.map((item) => item.suggestion)).toEqual([
    "Use VueUse useIntersectionObserver() for reactive observer cleanup.",
    "Use VueUse useResizeObserver() for reactive observer cleanup.",
    "Use VueUse useMutationObserver() for reactive observer cleanup.",
  ]);
  expect(events.diagnostics).toHaveLength(3);
  expect(storage.diagnostics.map((item) => item.suggestion)).toEqual([
    "Use VueUse useStorage() for reactive client storage state.",
    "Use VueUse useSessionStorage() for reactive client storage state.",
  ]);
  expect(scroll.diagnostics.map((item) => item.suggestion)).toEqual([
    "Use VueUse useScroll() for reactive browser state.",
    "Use VueUse useScroll() for reactive browser state.",
    "Use VueUse useElementBounding() for reactive browser state.",
  ]);
});

test("VueUse preference rules skip existing composables and non-runtime files", async () => {
  const timers = await runRuleFixture({
    rule: preferUseTimers,
    framework: "nuxt",
    files: {
      "app/components/Panel.vue": `<script setup lang="ts">
useTimeoutFn(() => {
  setTimeout(() => {}, 100)
}, 100)
</script>`,
      "server/api/timer.ts": `export default defineEventHandler(() => setTimeout(() => {}, 100))`,
      "shared/types/generated.ts": `// @generated\nsetInterval(() => {}, 100)`,
    },
  });
  const observers = await runRuleFixture({
    rule: preferUseObservers,
    framework: "nuxt",
    files: {
      "app/components/Panel.vue": `<script setup lang="ts">
useIntersectionObserver(target, () => {
  new IntersectionObserver(() => {})
})
</script>`,
      "app/generated/observer.ts": `new ResizeObserver(() => {})`,
    },
  });
  const events = await runRuleFixture({
    rule: preferUseEventListener,
    framework: "nuxt",
    files: {
      "app/components/Panel.vue": `<script setup lang="ts">
useEventListener(window, 'resize', () => {
  window.addEventListener('scroll', () => {})
})
</script>`,
      "docs/app/pages/index.vue": `<script setup lang="ts">window.addEventListener('resize', () => {})</script>`,
    },
  });
  const storage = await runRuleFixture({
    rule: preferUseStorage,
    framework: "nuxt",
    files: {
      "app/components/Panel.vue": `<script setup lang="ts">
const hasStorage = typeof localStorage !== 'undefined'
useStorage('theme', localStorage.getItem('theme'))
</script>`,
    },
  });

  expect(timers.diagnostics).toHaveLength(0);
  expect(observers.diagnostics).toHaveLength(0);
  expect(events.diagnostics).toHaveLength(0);
  expect(storage.diagnostics).toHaveLength(0);
});

test("VueUse timer preference ignores non-timer prototype methods", async () => {
  const result = await runRuleFixture({
    rule: preferUseTimers,
    framework: "nuxt",
    files: {
      "app/utils/colors.ts": `export function toHex(value: number) {
  return value.toString(16)
}

export function serialize(value: unknown) {
  return Object.prototype.toString.call(value)
}
`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test("route middleware security rule reports only auth-like middleware without server guards", async () => {
  const redirects = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/docs-version.global.ts": `export default defineNuxtRouteMiddleware((to) => {
  if (!to.path.startsWith('/docs/')) return
  return navigateTo('/docs/4.x')
})`,
      "app/middleware/guest.ts": `export default defineNuxtRouteMiddleware(() => {
  const { loggedIn } = useUserSession()
  if (loggedIn.value) return navigateTo('/admin')
})`,
      "server/api/feedback.get.ts": `export default defineEventHandler(() => [])`,
    },
  });
  const guarded = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => {
  const { loggedIn } = useUserSession()
  if (!loggedIn.value) return navigateTo('/admin/login')
})`,
      "server/api/admin.get.ts": `export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  if (!user?.login || !(await isAuthorizedAdmin(user.login))) throw createError({ statusCode: 403 })
  return {}
})`,
    },
  });
  const unguarded = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => {
  const { loggedIn } = useUserSession()
  if (!loggedIn.value) return navigateTo('/admin/login')
})`,
      "server/api/admin.get.ts": `export default defineEventHandler(() => ({}))`,
    },
  });

  expect(redirects.diagnostics).toHaveLength(0);
  expect(guarded.diagnostics).toHaveLength(0);
  expect(unguarded.diagnostics).toHaveLength(1);
  expect(unguarded.diagnostics[0]?.severity).toBe("warn");
});

test("a guard in one API handler does not hide an unguarded sensitive handler", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => navigateTo('/login'))`,
      "server/api/admin.get.ts": `export default defineEventHandler((event) => requireUserSession(event))`,
      "server/api/account.get.ts": `export default defineEventHandler(() => ({ private: true }))`,
      "server/api/feedback.get.ts": `export default defineEventHandler(() => [])`,
    },
  });

  const diagnostic = result.diagnostics.find(
    (item) => item.ruleId === noRouteMiddlewareApiSecurity.meta.id,
  );
  expect(diagnostic?.related?.map((item) => item.file)).toEqual([
    expect.stringContaining("server/api/account.get.ts"),
  ]);
  expect(diagnostic?.message).not.toContain("feedback.get.ts");
});

test("NUXT0037 recognizes a guard inside a cached event handler", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('/login'))",
      "server/api/account.get.ts":
        "export default cachedEventHandler(async event => { await requireUserSession(event); return { private: true } })",
    },
  });
  expect(result.diagnostics.filter((item) => item.code === "NUXT0037")).toHaveLength(0);
});

test.each([
  "auth/login.post.ts",
  "auth/sign-in.post.ts",
  "auth/signin.post.ts",
  "auth/callback.get.ts",
  "session/create.post.ts",
  "auth/register/index.post.ts",
  "auth/callback/index.get.ts",
  "auth/register.post.ts",
  "auth/forgot-password.post.ts",
  "auth/reset-password.post.ts",
  "auth/verify-email.get.ts",
  "auth/sign-up.post.ts",
])("public authentication endpoint %s does not require a server guard", async (endpoint) => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => navigateTo('/login'))`,
      "server/api/admin.get.ts": `export default defineEventHandler((event) => requireAuth(event))`,
      [`server/api/${endpoint}`]: `export default defineEventHandler(() => ({}))`,
      "server/handlers/entry.ts": `export default defineEventHandler(() => ({}))`,
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: new Date().toISOString(),
        nuxtVersion: "4",
        vueVersion: "3.5",
        appDir: "app",
        serverHandlers: [
          {
            file: "server/handlers/entry.ts",
            route: `/api/${endpoint.replace(/\.(get|post)?\.?ts$/, "").replace(/\/index$/, "")}`,
            method: endpoint.includes(".get.") ? "get" : "post",
          },
        ],
      }),
    },
  });
  expect(result.diagnostics).toHaveLength(0);
});

test.each([
  "auth/register/index.get.ts",
  "auth/register.get.ts",
  "auth/register.delete.ts",
  "auth/register.ts",
  "auth/callback.post.ts",
  "auth/logout.post.ts",
  "auth/revoke.post.ts",
  "auth/mfa.post.ts",
  "auth/[...all].ts",
  "session.delete.ts",
  "session.get.ts",
  "accounts.get.ts",
  "profiles.get.ts",
  "sessions.get.ts",
])("unguarded protected authentication endpoint %s is reported", async (endpoint) => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => navigateTo('/login'))`,
      [`server/api/${endpoint}`]: `export default defineEventHandler(() => ({}))`,
      "server/handlers/entry.ts": `export default defineEventHandler(() => ({}))`,
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: new Date().toISOString(),
        nuxtVersion: "4",
        vueVersion: "3.5",
        appDir: "app",
        serverHandlers: [
          {
            file: "server/handlers/entry.ts",
            route: `/api/${endpoint.replace(/\.(?:get|post|delete)?\.?ts$/, "")}`,
            method: endpoint.match(/\.(get|post|delete)\.ts$/)?.[1],
          },
        ],
      }),
    },
  });
  expect(result.diagnostics.map((item) => item.file)).toEqual(
    expect.arrayContaining([
      expect.stringContaining(`server/api/${endpoint}`),
      expect.stringContaining("server/handlers/entry.ts"),
    ]),
  );
});

test("path-scoped server middleware does not hide unrelated sensitive handlers", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => navigateTo('/login'))`,
      "server/middleware/auth.ts": `export default defineEventHandler((event) => {
        if (event.path.startsWith('/api/admin')) return requireAuth(event)
      })`,
      "server/api/account.get.ts": `export default defineEventHandler(() => ({}))`,
    },
  });
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.related?.map((item) => item.file)).toEqual([
    expect.stringContaining("server/api/account.get.ts"),
  ]);
});

test.each([
  ["requireAuth", 0],
  ["requireUserSession", 0],
  ["getUserSession", 1],
  ["unknownGuard", 1],
  ["(event) => requireAuth(event)", 0],
  ["async (event) => { const config = useRuntimeConfig(); await requireAuth(event) }", 0],
  ["async (event) => { logRequest(event); await requireAuth(event) }", 0],
  [
    "async (event) => { const config = useRuntimeConfig(); const session = await requireAuth(event) }",
    0,
  ],
  ["(event) => { logRequest(event); return requireAuth(event) }", 0],
  [
    "async (event) => { logRequest(event); if (event.path === '/api/account') return; await requireAuth(event) }",
    1,
  ],
  ["async (event) => { logRequest(event); return; await requireAuth(event) }", 1],
  ["async (event) => { logRequest(event); try { await requireAuth(event) } catch {} }", 1],
  ["async (event) => { await requireUserSession(event) }", 0],
  ["(event) => { return requireAuth(event) }", 0],
  ["async (event) => { return await requireAuth(event) }", 0],
  ["(event) => { if (event.path.startsWith('/api/admin')) return requireAuth(event) }", 1],
  ["async (event) => { if (event.path === '/api/account') return; await requireAuth(event) }", 1],
  ["async (event) => { try { await requireAuth(event) } catch {} }", 1],
  ["async (event) => { const { user } = await requireUserSession(event) }", 0],
  ["async (event) => { const session = await requireAuth(event) }", 0],
  ["(event) => { const session = requireAuth(event) }", 1],
  ["(event) => { requireAuth(event); return { private: true } }", 1],
  ["(event) => { requireAuth(otherEvent); return { private: true } }", 1],
  ["async (event) => { const session = await requireAuth(otherEvent) }", 1],
  ["(event) => { const guard = () => requireAuth(event) }", 1],
  ["(event) => { requireAuth(event) }", 1],
  ["async (event) => { requireAuth(event) }", 1],
  ["(event) => getUserSession(event)", 1],
  ["(event) => isAuthorizedAdmin(event)", 1],
  ["(event) => requireAuth(otherEvent)", 1],
])("server middleware guard coverage for %s", async (handler, count) => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => navigateTo('/login'))`,
      "server/middleware/auth.ts": `export default defineEventHandler(${handler})`,
      "server/api/account.get.ts": `export default defineEventHandler(() => ({}))`,
    },
  });
  expect(result.diagnostics).toHaveLength(count);
});

test.each([
  ["server/handlers/account.ts", "/api/data", false, false, 1],
  ["server/handlers/data.ts", "/api/account", true, false, 1],
  ["server/handlers/account.ts", "/api/account", true, true, 0],
  ["server/handlers/data.ts", "/api/health", true, false, 0],
])(
  "registered handler coverage for %s at %s",
  async (file, route, conventional, guarded, count) => {
    const result = await runRuleFixture({
      rule: noRouteMiddlewareApiSecurity,
      framework: "nuxt",
      files: {
        "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => navigateTo('/login'))`,
        [file]: guarded
          ? `export default defineEventHandler((event) => requireAuth(event))`
          : `export default defineEventHandler(() => ({}))`,
        ...(conventional
          ? { "server/api/health.ts": `export default defineEventHandler(() => ({}))` }
          : {}),
        ".nuxt/doctor.manifest.json": JSON.stringify({
          generatedAt: new Date().toISOString(),
          nuxtVersion: "4",
          vueVersion: "3.5",
          appDir: "app",
          serverHandlers: [{ file, route }],
        }),
      },
    });
    expect(result.diagnostics).toHaveLength(count);
    if (count)
      expect(result.diagnostics[0]?.related?.map((item) => item.file)).toEqual([
        expect.stringContaining(file),
      ]);
  },
);

test("missing registered handlers do not produce security diagnostics", async () => {
  const result = await runRuleFixture({
    rule: noRouteMiddlewareApiSecurity,
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => navigateTo('/login'))`,
      "server/handlers/current.ts": `export default defineEventHandler(() => ({}))`,
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: new Date().toISOString(),
        nuxtVersion: "4",
        vueVersion: "3.5",
        appDir: "app",
        serverHandlers: [
          { file: "server/handlers/account.ts", route: "/api/account" },
          { file: "server/handlers/current.ts", route: "/api/profile" },
        ],
      }),
    },
  });
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.related?.map((item) => item.file)).toEqual([
    expect.stringContaining("server/handlers/current.ts"),
  ]);
});

test.each([
  ["async (event) => { await requireAuth(event) }", undefined, undefined, 1],
  [
    "async (event) => { if (event.path === '/api/admin') await requireAuth(event) }",
    undefined,
    undefined,
    1,
  ],
  ["(event) => getUserSession(event)", undefined, undefined, 1],
  ["async (event) => { await requireAuth(event) }", "/api/admin/**", undefined, 1],
  ["async (event) => { await requireAuth(event) }", undefined, "GET", 1],
  ["async (event) => { await requireAuth(event) }", undefined, "post", 1],
])(
  "manifest-only middleware does not prove guard coverage for %s at %s with method %s",
  async (handler, route, method, count) => {
    const result = await runRuleFixture({
      rule: noRouteMiddlewareApiSecurity,
      framework: "nuxt",
      files: {
        "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => navigateTo('/login'))`,
        "server/handlers/auth.ts": `export default defineEventHandler(${handler})`,
        "server/handlers/data.ts": `export default defineEventHandler(() => ({}))`,
        ".nuxt/doctor.manifest.json": JSON.stringify({
          generatedAt: "2999-01-01T00:00:00.000Z",
          nuxtVersion: "4",
          vueVersion: "3.5",
          appDir: "app",
          serverHandlers: [
            { file: "server/handlers/auth.ts", middleware: true, route, method },
            { file: "server/handlers/data.ts", route: "/api/account", method: "POST" },
          ],
        }),
      },
    });
    expect(result.diagnostics).toHaveLength(count);
    if (count)
      expect(result.diagnostics[0]?.related?.map((item) => item.file)).toEqual([
        expect.stringContaining("server/handlers/data.ts"),
      ]);
  },
);

test.each([
  ["2999-01-01T00:00:00.000Z", "get", 1, "GET"],
  ["2999-01-01T00:00:00.000Z", "post", 1, "GET"],
  ["2999-01-01T00:00:00.000Z", undefined, 1, "GET"],
  ["2000-01-01T00:00:00.000Z", "get", 1, "GET"],
  [undefined, "get", 1, "GET"],
  ["2000-01-01T00:00:00.000Z", "get", 1, undefined],
])(
  "registered middleware currency %s and file method %s",
  async (generatedAt, method, count, middlewareMethod) => {
    const file = `server/api/account${method ? `.${method}` : ""}.ts`;
    const result = await runRuleFixture({
      rule: noRouteMiddlewareApiSecurity,
      framework: "nuxt",
      files: {
        "nuxt.config.ts": `export default defineNuxtConfig({})`,
        "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => navigateTo('/login'))`,
        "server/handlers/auth.ts": `export default defineEventHandler(async (event) => { await requireAuth(event) })`,
        [file]: `export default defineEventHandler(() => ({}))`,
        ".nuxt/doctor.manifest.json": JSON.stringify({
          generatedAt,
          nuxtVersion: "4",
          vueVersion: "3.5",
          appDir: "app",
          serverHandlers: [
            { file: "server/handlers/auth.ts", middleware: true, method: middlewareMethod },
          ],
        }),
      },
    });
    expect(result.diagnostics).toHaveLength(count);
  },
);

test("route middleware security ignores sensitive ancestor directory names", async () => {
  await withFixture(
    {
      "user/project/package.json": JSON.stringify({ dependencies: { nuxt: "^4.0.0" } }),
      "user/project/app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => navigateTo('/login'))`,
      "user/project/server/api/feedback.get.ts": `export default defineEventHandler(() => [])`,
    },
    {},
    async (root) => {
      const result = await runDoctor({
        root: join(root, "user/project"),
        framework: "nuxt",
        runtimeTarget: { nuxt: "4.0.0" },
        extensions: [
          defineDoctorExtension({
            name: "fixture",
            rulePacks: [
              defineRulePack({
                name: "fixture",
                version: "0.0.0",
                rules: [noRouteMiddlewareApiSecurity],
                presets: { recommended: [noRouteMiddlewareApiSecurity.meta.id] },
              }),
            ],
          }),
        ],
      });
      expect(result.diagnostics).toHaveLength(0);
    },
  );
});

test.each(["mts", "cts", "cjs"])(
  "route middleware security includes %s handlers",
  async (extension) => {
    const result = await runRuleFixture({
      rule: noRouteMiddlewareApiSecurity,
      framework: "nuxt",
      files: {
        "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => navigateTo('/login'))`,
        "server/api/feedback.get.ts": `export default defineEventHandler(() => [])`,
        [`server/api/account.get.${extension}`]: `export default defineEventHandler(() => ({}))`,
      },
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.related?.map((item) => item.file)).toEqual([
      expect.stringContaining(`server/api/account.get.${extension}`),
    ]);
  },
);

test("module packs activate from dependencies", async () => {
  await withFixture(
    {
      "app/pages/index.vue": `<script setup lang="ts">queryContent('/docs')</script>`,
    },
    { "@nuxt/content": "^3.0.0" },
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "nuxt",
        runtimeTarget: { nuxt: "4.0.0" },
        extensions: [
          defineDoctorExtension({
            name: "fixture",
            rulePacks: [nuxtContentRulePack],
          }),
        ],
      });

      expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
        "nuxt-content/no-querycontent-legacy-api",
      ]);
    },
  );
});

test("module packs stay inactive when dependency is absent", async () => {
  await withFixture(
    {
      "app/pages/index.vue": `<script setup lang="ts">queryContent('/docs')</script>`,
    },
    {},
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "nuxt",
        runtimeTarget: { nuxt: "4.0.0" },
        extensions: [
          defineDoctorExtension({
            name: "fixture",
            rulePacks: [nuxtContentRulePack],
          }),
        ],
      });

      expect(result.diagnostics).toHaveLength(0);
    },
  );
});

test("Docus content links report missing internal to targets", async () => {
  await withFixture(
    {
      "content/index.md": `:u-button{to="/vue" label="Vue"}\n:u-button{to="https://example.com" label="External"}`,
      "content/1.vue/index.md": `::u-page-card\n---\nto: /vue/rules\n---\n::`,
      "content/1.vue/3.rules.md": `# Vue rules`,
      "content/2.nuxt/2.getting-started.md": `# Getting started`,
      "content/2.nuxt/index.md": `:u-button{to="/nuxt/getting-started#install" label="Start"}`,
      "content/3.bad/index.md": `::u-page-card\n---\nto: /missing\n---\n::`,
    },
    { docus: "^5.8.0", "@nuxt/content": "^3.0.0" },
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "nuxt",
        runtimeTarget: { nuxt: "4.0.0" },
        extensions: [defineDoctorExtension({ name: "fixture", rulePacks: [docusRulePack] })],
      });

      expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
        "nuxt-content/links/no-broken-internal-to-link",
      ]);
      expect(result.diagnostics[0]?.message).toContain("/missing");
    },
  );
});

test("Docus app.vue shadow rule reports empty local app shell only", async () => {
  await withFixture(
    {
      "app/app.vue": `<template><NuxtPage /></template>`,
    },
    { docus: "^5.8.0" },
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "nuxt",
        runtimeTarget: { nuxt: "4.0.0" },
        extensions: [defineDoctorExtension({ name: "fixture", rulePacks: [docusRulePack] })],
      });

      expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
        "docus/layers/no-empty-app-vue-shadow",
      ]);
    },
  );

  await withFixture(
    {
      "app/app.vue": `<script setup>const locale = useState('locale')</script><template><UApp><AppHeader /><NuxtPage /></UApp></template>`,
    },
    { docus: "^5.8.0" },
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "nuxt",
        runtimeTarget: { nuxt: "4.0.0" },
        extensions: [defineDoctorExtension({ name: "fixture", rulePacks: [docusRulePack] })],
      });

      expect(result.diagnostics).toHaveLength(0);
    },
  );
});

test("Docus app config rule reports unknown top-level keys", async () => {
  await withFixture(
    {
      "app/app.config.ts": `export default defineAppConfig({
  docus: { locale: 'en' },
  header: { title: 'Vue Doctor' },
  navigation: { sub: 'header' },
  github: { url: 'https://github.com/onmax/vite-doctor', branch: 'main', rootDir: 'docs' },
  assistant: { explainWithAi: false },
  toc: { title: 'On This Page' },
  ui: { colors: { primary: 'emerald' } },
  docsModules: ['vue', 'nuxt'],
})`,
    },
    { docus: "^5.8.0" },
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "nuxt",
        runtimeTarget: { nuxt: "4.0.0" },
        extensions: [defineDoctorExtension({ name: "fixture", rulePacks: [docusRulePack] })],
      });

      expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
        "docus/appconfig/no-unknown-key",
      ]);
      expect(result.diagnostics[0]?.message).toContain("docsModules");
    },
  );
});

test("Docus rule pack activates from static extends and stays inactive without Docus", async () => {
  await withFixture(
    {
      "nuxt.config.ts": `export default defineNuxtConfig({ extends: ['docus'] })`,
      "app/app.config.ts": `export default defineAppConfig({ docsModules: ['vue'] })`,
    },
    {},
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "nuxt",
        runtimeTarget: { nuxt: "4.0.0" },
        extensions: [defineDoctorExtension({ name: "fixture", rulePacks: [docusRulePack] })],
      });

      expect(result.diagnostics.map((item) => item.ruleId)).toEqual([
        "docus/appconfig/no-unknown-key",
      ]);
    },
  );

  await withFixture(
    {
      "app/app.config.ts": `export default defineAppConfig({ docsModules: ['vue'] })`,
    },
    { "@nuxt/content": "^3.0.0" },
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "nuxt",
        runtimeTarget: { nuxt: "4.0.0" },
        extensions: [defineDoctorExtension({ name: "fixture", rulePacks: [docusRulePack] })],
      });

      expect(result.diagnostics).toHaveLength(0);
    },
  );
});

test("NuxtManifest visitors run once per rule", async () => {
  await withFixture(
    {
      "app/pages/one.vue": `<template><div /></template>`,
      "app/pages/two.vue": `<template><div /></template>`,
      "app/composables/nested/useThing.ts": `export function useThing() { return true }`,
    },
    {},
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "nuxt",
        extensions: [
          defineDoctorExtension({
            name: "fixture",
            rulePacks: [
              defineRulePack({
                name: "fixture",
                version: "0.0.0",
                rules: [noNestedAutoimportAssumption],
                presets: { recommended: ["nuxt/composables/no-nested-autoimport-assumption"] },
              }),
            ],
          }),
        ],
      });

      expect(result.diagnostics).toHaveLength(1);
    },
  );
});

test("manifest import dirs suppress configured nested composable warning", async () => {
  await withFixture(
    {
      "app/composables/nested/useThing.ts": `export function useThing() { return true }`,
    },
    {},
    async (root) => {
      await writeFileManifest(root, [], {
        importsDirs: [join(root, "app/composables/nested")],
      });
      const result = await runDoctor({
        root,
        framework: "nuxt",
        extensions: [
          defineDoctorExtension({
            name: "fixture",
            rulePacks: [
              defineRulePack({
                name: "fixture",
                version: "0.0.0",
                rules: [noNestedAutoimportAssumption],
                presets: { recommended: ["nuxt/composables/no-nested-autoimport-assumption"] },
              }),
            ],
          }),
        ],
      });

      expect(result.diagnostics).toHaveLength(0);
    },
  );
});

test("manifest import globs suppress configured nested composable warning", async () => {
  await withFixture(
    {
      "app/composables/npm/usePackage.ts": `export function usePackage() { return true }`,
    },
    {},
    async (root) => {
      await writeFileManifest(root, [], {
        importsDirs: ["~/composables", "~/composables/*/*.ts"],
      });
      const result = await runDoctor({
        root,
        framework: "nuxt",
        extensions: [
          defineDoctorExtension({
            name: "fixture",
            rulePacks: [
              defineRulePack({
                name: "fixture",
                version: "0.0.0",
                rules: [noNestedAutoimportAssumption],
                presets: { recommended: ["nuxt/composables/no-nested-autoimport-assumption"] },
              }),
            ],
          }),
        ],
      });

      expect(result.diagnostics).toHaveLength(0);
    },
  );
});

test("nuxt config import globs suppress nested composable warning without manifest", async () => {
  await withFixture(
    {
      "nuxt.config.ts": `export default defineNuxtConfig({
  imports: {
    dirs: ["~/composables", "~/composables/*/*.ts"],
  },
})`,
      "app/composables/npm/usePackage.ts": `export function usePackage() { return true }`,
    },
    {},
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "nuxt",
        extensions: [
          defineDoctorExtension({
            name: "fixture",
            rulePacks: [
              defineRulePack({
                name: "fixture",
                version: "0.0.0",
                rules: [noNestedAutoimportAssumption],
                presets: { recommended: ["nuxt/composables/no-nested-autoimport-assumption"] },
              }),
            ],
          }),
        ],
      });

      expect(result.diagnostics).toHaveLength(0);
    },
  );
});

test("app-relative nuxt config import dirs suppress nested composable warning", async () => {
  await withFixture(
    {
      "nuxt.config.ts": `export default defineNuxtConfig({
  imports: {
    dirs: ["./composables/masto"],
  },
})`,
      "app/composables/masto/account.ts": `export function useAccount() { return true }`,
    },
    {},
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "nuxt",
        extensions: [
          defineDoctorExtension({
            name: "fixture",
            rulePacks: [
              defineRulePack({
                name: "fixture",
                version: "0.0.0",
                rules: [noNestedAutoimportAssumption],
                presets: { recommended: ["nuxt/composables/no-nested-autoimport-assumption"] },
              }),
            ],
          }),
        ],
      });

      expect(result.diagnostics).toHaveLength(0);
    },
  );
});

test("nested composable warning ignores helper modules in composables folders", async () => {
  await withFixture(
    {
      "app/composables/tiptap/emoji.ts": `export const TiptapPluginEmoji = Node.create({ name: "emoji" })`,
      "app/composables/idb/index.ts": `export async function useAsyncIDBKeyval() { return true }`,
    },
    {},
    async (root) => {
      const result = await runDoctor({
        root,
        framework: "nuxt",
        extensions: [
          defineDoctorExtension({
            name: "fixture",
            rulePacks: [
              defineRulePack({
                name: "fixture",
                version: "0.0.0",
                rules: [noNestedAutoimportAssumption],
                presets: { recommended: ["nuxt/composables/no-nested-autoimport-assumption"] },
              }),
            ],
          }),
        ],
      });

      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]?.file).toContain("app/composables/idb/index.ts");
    },
  );
});

test("manifest plugin files suppress configured nested plugin warning", async () => {
  await withFixture(
    {
      "app/plugins/nested/analytics.ts": `export default defineNuxtPlugin(() => {})`,
    },
    {},
    async (root) => {
      await writeFileManifest(root, [], {
        pluginFiles: [join(root, "app/plugins/nested/analytics.ts")],
      });
      const result = await runDoctor({
        root,
        framework: "nuxt",
        extensions: [
          defineDoctorExtension({
            name: "fixture",
            rulePacks: [
              defineRulePack({
                name: "fixture",
                version: "0.0.0",
                rules: [noSubdirPluginAutoRegistrationAssumption],
                presets: { recommended: ["nuxt/plugins/no-subdir-auto-registration-assumption"] },
              }),
            ],
          }),
        ],
      });

      expect(result.diagnostics).toHaveLength(0);
    },
  );
});

test("explicit auto-import rule follows the resolved Nuxt registry and configuration", async () => {
  async function runCase(
    source: string,
    manifest: Record<string, unknown> = {},
    file = "app/components/Alerts/Shared/ListMessage.vue",
    severity?: "error",
  ) {
    let diagnostics: Awaited<ReturnType<typeof runDoctor>>["diagnostics"] = [];
    await withFixture(
      {
        [file]: `<script setup lang="ts">${source}</script>`,
        "app/utils/alerts.ts": `export function getAlertListValue() { return '' }`,
      },
      {},
      async (root) => {
        await writeFileManifest(root, [], {
          generatedAt: new Date().toISOString(),
          autoImportEnabled: true,
          autoImports: [
            {
              name: "getAlertListValue",
              as: "getAlertListValue",
              from: join(root, "app/utils/alerts.ts"),
            },
          ],
          ...manifest,
        });
        const result = await runDoctor({
          root,
          framework: "nuxt",
          config: severity
            ? { rules: { "nuxt/imports/no-explicit-auto-import": severity } }
            : undefined,
          runtimeTarget: { nuxt: "4.0.0" },
          extensions: [
            defineDoctorExtension({
              name: "fixture",
              rulePacks: [
                defineRulePack({
                  name: "fixture",
                  version: "0.0.0",
                  rules: [noExplicitAutoImport],
                  presets: { recommended: ["nuxt/imports/no-explicit-auto-import"] },
                }),
              ],
            }),
          ],
        });
        diagnostics = result.diagnostics;
      },
    );
    return diagnostics;
  }

  const portalImport = await runCase(
    `import { getAlertListValue } from '~/utils/alerts'\ngetAlertListValue()`,
  );
  expect(portalImport).toHaveLength(1);
  expect(portalImport[0]).toMatchObject({
    ruleId: "nuxt/imports/no-explicit-auto-import",
    severity: "warn",
  });
  expect(portalImport[0]?.fix?.kind).toBe("safe");

  const blockingPortalImport = await runCase(
    `import { getAlertListValue } from '#imports'\ngetAlertListValue()`,
    {},
    "app/components/Alerts/Shared/ListMessage.vue",
    "error",
  );
  expect(blockingPortalImport[0]?.severity).toBe("error");

  expect(
    await runCase(`import { getAlertListValue } from 'other-package'\ngetAlertListValue()`),
  ).toHaveLength(0);
  expect(
    await runCase(`import type { getAlertListValue } from '~/utils/alerts'`, {}, "app/types.ts"),
  ).toHaveLength(0);
  expect(
    await runCase(`import { getAlertListValue as localValue } from '~/utils/alerts'\nlocalValue()`),
  ).toHaveLength(0);
  expect(
    await runCase(
      `import { getAlertListValue } from '~/utils/alerts'\ngetAlertListValue()`,
      {},
      "server/api/alerts.ts",
    ),
  ).toHaveLength(0);
  expect(
    await runCase(`import { getAlertListValue } from '~/utils/alerts'`, {
      autoImportEnabled: false,
    }),
  ).toHaveLength(0);
  expect(
    await runCase(`import { getAlertListValue } from '~/utils/alerts'`, {
      generatedAt: "invalid",
    }),
  ).toHaveLength(0);
  expect(
    await runCase(`import { getAlertListValue } from '~/utils/alerts'`, {
      autoImportEnabled: undefined,
    }),
  ).toHaveLength(0);
  expect(
    await runCase(`import { getAlertListValue } from '~/utils/alerts'`, {
      autoImportTransform: {
        include: [],
        exclude: [{ source: "ListMessage\\.vue$", flags: "" }],
      },
    }),
  ).toHaveLength(0);
});

test("Nuxt module writes manifest and accepts context hook contributions", async () => {
  await withFixture({}, {}, async (root) => {
    const nuxt = {
      options: { rootDir: root, buildDir: ".nuxt", modules: [] },
      async callHook(name: string, payload: any) {
        if (name !== "doctor:context") return;
        payload.manifest.modules.push({ name: "fixture-module", doctorPlugin: "fixture" });
      },
    };

    await writeManifest(nuxt);

    const manifestPath = join(root, ".nuxt/doctor.manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.modules.some((module: any) => module.name === "fixture-module")).toBe(true);
  });
});

test("Nuxt module exposes native Doctor config", async () => {
  expect(await nuxtDoctorModule.getMeta?.()).toEqual({
    name: "vite-doctor",
    configKey: "doctor",
    compatibility: { nuxt: ">=4.1.0" },
    docs: "https://vite-doctor.onmax.me/nuxt",
  });
});

test("Nuxt module records the resolved auto-import registry", async () => {
  await withFixture({}, {}, async (root) => {
    const hooks = new Map<string, Array<(payload: any) => unknown>>();
    const nuxt = {
      _version: "4.5.1",
      options: {
        rootDir: root,
        srcDir: "app",
        buildDir: ".nuxt",
        modules: [],
        imports: {
          autoImport: true,
          imports: [],
          transform: { exclude: [/generated/] },
        },
      },
      hook(name: string, callback: (payload: any) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), callback]);
      },
      async callHook() {},
    };

    await nuxtDoctorModule({}, nuxt as any);
    for (const hook of hooks.get("imports:context") ?? [])
      await hook({
        getImports: async () => [
          {
            name: "getAlertListValue",
            as: "getAlertListValue",
            from: join(root, "app/utils/alerts.ts"),
          },
        ],
      });
    for (const hook of hooks.get("prepare:types") ?? []) await hook(undefined);

    expect(
      JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8")),
    ).toMatchObject({
      appDir: join(root, "app"),
      autoImportEnabled: true,
      autoImportTransform: {
        exclude: [{ source: "generated", flags: "" }],
      },
      autoImports: [
        {
          name: "getAlertListValue",
          as: "getAlertListValue",
          from: join(root, "app/utils/alerts.ts"),
        },
      ],
    });
  });
});

test("Nuxt module timestamps changed evidence without rewriting identical manifests", async () => {
  await withFixture({}, {}, async (root) => {
    const nuxt = {
      options: {
        rootDir: root,
        buildDir: ".nuxt",
        modules: [],
        future: { compatibilityVersion: 4 },
      },
    };

    const first = await writeManifest(nuxt);
    const unchanged = await writeManifest(nuxt);
    expect(unchanged.generatedAt).toBe(first.generatedAt);

    await new Promise((resolve) => setTimeout(resolve, 2));
    nuxt.options.future.compatibilityVersion = 5;
    const changed = await writeManifest(nuxt);

    expect(changed.generatedAt! > first.generatedAt!).toBe(true);
    expect(
      JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8")),
    ).toMatchObject({
      generatedAt: changed.generatedAt,
      compatibilityVersion: 5,
    });
  });
});

test("Nuxt module recreates an unchanged manifest after the build directory is cleaned", async () => {
  await withFixture({}, {}, async (root) => {
    const nuxt = {
      options: { rootDir: root, buildDir: ".nuxt", modules: [] },
    };

    const first = await writeManifest(nuxt);
    const manifestPath = join(root, ".nuxt/doctor.manifest.json");
    await rm(join(root, ".nuxt"), { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const recreated = await writeManifest(nuxt);

    expect(existsSync(manifestPath)).toBe(true);
    expect(recreated.generatedAt).not.toBe(first.generatedAt);
  });
});

test("Nuxt module writes Doctor config and Doctor Run applies it", async () => {
  await withFixture(
    {
      "app/pages/index.vue": `<script setup lang="ts">
import { useRoute } from "vue-router";
useRoute();
</script>`,
    },
    {},
    async (root) => {
      const nuxt = {
        _version: "4.5.1",
        options: { rootDir: root, buildDir: ".nuxt", modules: [] },
        async callHook() {},
      };

      await nuxtDoctorModule(
        {
          rules: { "nuxt/routing/prefer-nuxt-useroute": "off" },
        },
        nuxt as any,
      );
      await writeManifest(nuxt);

      const manifest = JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8"));
      expect(manifest.doctorConfig).toEqual({
        rules: { "nuxt/routing/prefer-nuxt-useroute": "off" },
      });

      const result = await runDoctor({
        root,
        framework: "nuxt",
        runtimeTarget: {
          nuxt: "4.0.0",
          nitro: "2.0.0",
          h3: "1.0.0",
          vue: "3.5.0",
          nuxtCompatibility: 4,
        },
        extensions: nuxtDoctorExtensions(),
      });
      expect(result.diagnostics.map((item) => item.ruleId)).not.toContain(
        "nuxt/routing/prefer-nuxt-useroute",
      );
      expect(existsSync(join(root, ".nuxt/doctor/cache"))).toBe(true);
      expect(existsSync(join(root, ".vite-doctor"))).toBe(false);
    },
  );
});
