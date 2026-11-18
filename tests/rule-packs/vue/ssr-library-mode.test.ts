import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { afterEach, expect, test } from "vite-plus/test";
import { detectProject } from "../../../src/core/index.ts";
import { runViteDoctor } from "../../../src/doctor.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "doctor-vue-ssr-library-"));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

// A component library that ships a Nuxt module, a Vue composable package it depends on, a Nuxt
// app that renders the library, and a Vue package nothing server-renders.
function libraryWorkspace(members: Record<string, string> = {}) {
  return fixture({
    "package.json": JSON.stringify({ name: "workspace", private: true }),
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n  - "apps/*"\n',
    "packages/ui/package.json": JSON.stringify({
      name: "@acme/ui",
      exports: { ".": "./dist/index.js", "./nuxt": "./dist/nuxt.js" },
      dependencies: { "@acme/container": "workspace:*" },
      peerDependencies: { vue: "^3.5.0" },
      devDependencies: { vue: "^3.5.0" },
    }),
    "packages/container/package.json": JSON.stringify({
      name: "@acme/container",
      exports: { ".": "./dist/index.js", "./vue": "./dist/vue.js" },
      peerDependencies: { vue: "^3.5.0" },
      devDependencies: { vue: "^3.5.0" },
    }),
    "packages/charts/package.json": JSON.stringify({
      name: "@acme/charts",
      dependencies: { vue: "^3.5.0" },
    }),
    "packages/widgets/package.json": JSON.stringify({
      name: "@acme/widgets",
      peerDependencies: { vue: "^3.5.0" },
      devDependencies: { vue: "^3.5.0" },
    }),
    "packages/console/package.json": JSON.stringify({
      name: "@acme/console",
      exports: { ".": "./dist/index.js", "./nuxt": "./dist/nuxt.js" },
      dependencies: { vue: "^3.5.0" },
    }),
    "packages/console/src/client/main.ts": `import { createApp } from "vue";
import App from "./app.vue";
createApp(App).mount("#console");
`,
    "packages/server-utils/package.json": JSON.stringify({ name: "@acme/server-utils" }),
    "apps/site/package.json": JSON.stringify({
      name: "site",
      dependencies: {
        nuxt: "^4.0.0",
        vue: "^3.5.0",
        "@acme/widgets": "workspace:*",
        "@acme/console": "workspace:*",
        "@acme/server-utils": "workspace:*",
      },
    }),
    "apps/site/nuxt.config.ts": "export default defineNuxtConfig({})\n",
    "apps/site/app/app.vue": "<template><NuxtPage /></template>\n",
    ...members,
  });
}

const ssrRules = "vue/ssr/*";

async function ssrDiagnostics(root: string) {
  const result = await runViteDoctor({
    root,
    cache: false,
    extends: ["vite-doctor/vue/strict", "vite-doctor/nuxt/strict"],
    runtimeTarget: { nuxt: "4.1.0" },
  });
  return result.diagnostics
    .filter((item) => /^(vue\/ssr\/|nuxt\/hydration\/)/.test(item.ruleId))
    .map((item) => `${item.ruleId}:${item.file.slice(root.length + 1)}:${item.range?.line}`)
    .sort();
}

test("Project Inventory records why a workspace package renders on the server", async () => {
  const root = libraryWorkspace();

  const project = await detectProject(root);

  expect(
    Object.fromEntries((project.workspacePackages ?? []).map((item) => [item.root, item.ssr])),
  ).toEqual({
    ".": undefined,
    "apps/site": undefined,
    "packages/charts": undefined,
    "packages/console": undefined,
    "packages/container": "the server-rendered package packages/ui depends on it",
    "packages/ui": "its package.json exports ./nuxt, and Nuxt server-renders components by default",
    "packages/server-utils": undefined,
    "packages/widgets": "the Nuxt app apps/site depends on it",
  });
});

test("a Nuxt app with ssr: false does not make its dependencies server-rendered", async () => {
  const root = libraryWorkspace({
    "apps/site/nuxt.config.ts": "export default defineNuxtConfig({ ssr: false })\n",
  });

  const project = await detectProject(root);

  expect(project.workspacePackages?.find((item) => item.root === "packages/widgets")?.ssr).toBe(
    undefined,
  );
});

const agentSession = `import { defineComponent, h, ref } from "vue";

interface StoredLayout { panelOpen?: boolean; width?: number }

function readLayout(key: string | undefined): StoredLayout {
  if (!key || typeof localStorage === "undefined") return {};
  return JSON.parse(localStorage.getItem(key) ?? "{}") as StoredLayout;
}

export const AgentSession = defineComponent({
  props: { storageKey: String, defaultWidth: { type: Number, default: 320 } },
  setup(props) {
    const stored = readLayout(props.storageKey);
    const panelOpen = ref(stored.panelOpen ?? false);
    const width = ref(stored.width ?? props.defaultWidth);
    return () => h("div", { style: { width: \`\${width.value}px\` } }, panelOpen.value ? "open" : "closed");
  },
});
`;

const agentSessionFixed = `import { defineComponent, h, onMounted, ref } from "vue";

interface StoredLayout { panelOpen?: boolean; width?: number }

function readLayout(key: string | undefined): StoredLayout {
  if (!key || typeof localStorage === "undefined") return {};
  return JSON.parse(localStorage.getItem(key) ?? "{}") as StoredLayout;
}

export const AgentSession = defineComponent({
  props: { storageKey: String, defaultWidth: { type: Number, default: 320 } },
  setup(props) {
    const panelOpen = ref(false);
    const width = ref(props.defaultWidth);
    onMounted(() => {
      const stored = readLayout(props.storageKey);
      panelOpen.value = stored.panelOpen ?? panelOpen.value;
      width.value = stored.width ?? width.value;
    });
    return () => h("div", { style: { width: \`\${width.value}px\` } }, panelOpen.value ? "open" : "closed");
  },
});
`;

const useContainer = `import { ref } from "vue";

function browserWindow(): Window | undefined {
  return typeof window === "undefined" ? undefined : window;
}

export function useContainer() {
  const online = ref(browserWindow()?.navigator.onLine ?? true);
  return { online };
}
`;

const connectStore = `import { ref } from "vue";

function browserStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  return window.sessionStorage;
}

function read(storage: Storage | undefined, key: string): Record<string, string> {
  return JSON.parse(storage?.getItem(key) ?? "{}");
}

export function useConnectStore(key = "connect") {
  const storage = browserStorage();
  const credentials = ref<Record<string, string>>(read(storage, key));
  return { credentials };
}
`;

test("reports setup state initialized from a browser read through a guarded helper", async () => {
  const root = libraryWorkspace({
    "packages/ui/src/agent-session.ts": agentSession,
    "packages/ui/src/connect-store.ts": connectStore,
    "packages/container/src/vue.ts": useContainer,
  });

  expect(
    (await ssrDiagnostics(root)).filter((item) =>
      item.startsWith("vue/ssr/no-setup-state-from-browser-read"),
    ),
  ).toEqual([
    "vue/ssr/no-setup-state-from-browser-read:packages/container/src/vue.ts:8",
    "vue/ssr/no-setup-state-from-browser-read:packages/ui/src/agent-session.ts:14",
    "vue/ssr/no-setup-state-from-browser-read:packages/ui/src/agent-session.ts:15",
    "vue/ssr/no-setup-state-from-browser-read:packages/ui/src/connect-store.ts:14",
  ]);
});

test("reports guarded reads in computed() getters once, where the state is created", async () => {
  const root = libraryWorkspace({
    "packages/ui/src/margin.ts": `import { computed, ref } from "vue";
export function useMargin(placement: string) {
  const screenWidth = ref(typeof window === "undefined" ? 0 : window.innerWidth);
  const inMargin = computed(() => placement === "margin" && screenWidth.value >= 1200);
  const dark = computed(() => {
    if (typeof matchMedia === "undefined") return false;
    return matchMedia("(prefers-color-scheme: dark)").matches;
  });
  return { inMargin, dark };
}
`,
  });

  expect(await ssrDiagnostics(root)).toEqual([
    "vue/ssr/no-setup-state-from-browser-read:packages/ui/src/margin.ts:3",
    "vue/ssr/no-setup-state-from-browser-read:packages/ui/src/margin.ts:5",
  ]);
});

test("names the browser global and the helper that reads it", async () => {
  const root = libraryWorkspace({ "packages/container/src/vue.ts": useContainer });

  const result = await runViteDoctor({
    root,
    cache: false,
    extends: ["vite-doctor/vue/strict"],
    rules: "vue/ssr/no-setup-state-from-browser-read",
  });
  const diagnostics = result.diagnostics.filter((item) => item.ruleId.startsWith("vue/"));

  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]?.why).toContain("browserWindow() reads window");
  expect(diagnostics[0]?.why).toContain("the server-rendered package packages/ui depends on it");
});

test("accepts state from a composable that touches the browser without returning what it read", async () => {
  const root = libraryWorkspace({
    "packages/ui/src/store.ts": `import { ref } from "vue";

function browserStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.sessionStorage;
}

export function useStore() {
  const storage = browserStorage();
  const items = ref<string[]>([]);
  function save() {
    storage?.setItem("items", JSON.stringify(items.value));
  }
  return { items, save };
}
`,
    "packages/ui/src/panel.ts": `import { defineComponent, h, ref } from "vue";
import { useStore } from "./store";

export const Panel = defineComponent({
  setup() {
    const store = useStore();
    const count = ref(store.items.value.length);
    return () => h("span", count.value);
  },
});
`,
  });

  expect(await ssrDiagnostics(root)).toEqual([]);
});

test("accepts state that reads the browser after mount", async () => {
  const root = libraryWorkspace({ "packages/ui/src/agent-session.ts": agentSessionFixed });

  expect(await ssrDiagnostics(root)).toEqual([]);
});

test("does not report packages without server-rendering evidence", async () => {
  const root = libraryWorkspace({
    "packages/charts/src/agent-session.ts": agentSession,
    "packages/charts/src/clock.ts": `import { defineComponent, h } from "vue";
export const Clock = defineComponent({ setup: () => () => h("time", Date.now()) });
`,
  });

  expect(await ssrDiagnostics(root)).toEqual([]);
});

test("the Rule option ssr marks a package with no workspace consumer as server-rendered", async () => {
  const root = libraryWorkspace({ "packages/charts/src/agent-session.ts": agentSession });

  const result = await runViteDoctor({
    root,
    cache: false,
    extends: ["vite-doctor/vue/strict"],
    config: { rules: { "vue/ssr/no-setup-state-from-browser-read": ["warn", { ssr: true }] } },
  });

  expect(
    result.diagnostics
      .filter((item) => item.ruleId === "vue/ssr/no-setup-state-from-browser-read")
      .map((item) => item.range?.line),
  ).toEqual([14, 15]);
});

test("leaves Nuxt app files to the Nuxt hydration Rules", async () => {
  const root = libraryWorkspace({
    "apps/site/app/components/Layout.vue": `<script setup lang="ts">
const width = ref(Number(localStorage.getItem("width") ?? 320))
const now = Date.now()
</script>
<template><div :style="{ width: width + 'px' }">{{ now }}</div></template>
`,
  });

  const diagnostics = await ssrDiagnostics(root);

  expect(diagnostics.filter((item) => item.startsWith("vue/ssr/"))).toEqual([]);
  expect(diagnostics.some((item) => item.startsWith("nuxt/hydration/"))).toBe(true);
});

const commentRow = `import { h } from "vue";
import { timeAgo } from "./format";

export function threadRow(thread: { updatedAt: number; author: string }, now?: number) {
  return [
    h("span", thread.author),
    h("span", timeAgo(thread.updatedAt)),
    h("span", timeAgo(thread.updatedAt, now ?? 0)),
  ];
}
`;

const format = `/** "5 minutes ago", or "now" for under a minute. */
export function timeAgo(at: number, now: number = Date.now()): string {
  const minutes = Math.round((at - now) / 60_000);
  return minutes ? new Intl.RelativeTimeFormat("en").format(minutes, "minute") : "now";
}

export function formatBytes(bytes: number): string {
  console.debug("formatted at", Date.now());
  return \`\${Math.round(bytes / 1024)} KB\`;
}
`;

const commentReply = `import { defineComponent, h } from "vue";
import { formatBytes } from "./format";

export const CommentReply = defineComponent({
  props: { createdAt: { type: Number, required: true }, size: { type: Number, default: 0 } },
  setup(props) {
    const onCopy = () => navigator.clipboard.writeText(new Date().toLocaleString());
    return () => h("div", [
      h("time", {
        datetime: new Date(props.createdAt).toISOString(),
        title: new Date(props.createdAt).toLocaleString(),
      }, formatBytes(props.size)),
      h("span", new Intl.DateTimeFormat(undefined, { dateStyle: "short" }).format(props.createdAt)),
      h("span", new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).format(props.createdAt)),
      h("span", props.size.toLocaleString("en-US")),
      h("button", { onClick: onCopy }, "Copy"),
    ]);
  },
});
`;

const legacyClock = `import { defineComponent, h } from "vue";

export const LegacyClock = defineComponent({
  render() {
    return h("span", Math.random());
  },
});
`;

test("reports random, current-time and locale-dependent values in render functions", async () => {
  const root = libraryWorkspace({
    "packages/ui/src/comment-row.ts": commentRow,
    "packages/ui/src/format.ts": format,
    "packages/ui/src/comment-reply.ts": commentReply,
    "packages/ui/src/legacy-clock.ts": legacyClock,
    // threadRow() reports the time it renders itself, so its callers do not report it again.
    "packages/ui/src/comment-list.ts": `import { defineComponent, h, type PropType } from "vue";
import { threadRow } from "./comment-row";

export const CommentList = defineComponent({
  props: { threads: { type: Array as PropType<Array<{ updatedAt: number; author: string }>>, required: true } },
  setup: (props) => () => h("ul", props.threads.map((thread) => h("li", threadRow(thread)))),
});
`,
  });

  expect(
    (await ssrDiagnostics(root)).filter((item) =>
      item.startsWith("vue/ssr/no-random-or-local-time-render"),
    ),
  ).toEqual([
    "vue/ssr/no-random-or-local-time-render:packages/ui/src/comment-reply.ts:11",
    "vue/ssr/no-random-or-local-time-render:packages/ui/src/comment-reply.ts:13",
    "vue/ssr/no-random-or-local-time-render:packages/ui/src/comment-row.ts:7",
    "vue/ssr/no-random-or-local-time-render:packages/ui/src/legacy-clock.ts:5",
  ]);
});

test("explains which helper reads the clock", async () => {
  const root = libraryWorkspace({
    "packages/ui/src/comment-row.ts": commentRow,
    "packages/ui/src/format.ts": format,
  });

  const result = await runViteDoctor({
    root,
    cache: false,
    extends: ["vite-doctor/vue/strict"],
    rules: "vue/ssr/no-random-or-local-time-render",
  });

  expect(
    result.diagnostics.filter((item) => item.ruleId.startsWith("vue/")).map((item) => item.why),
  ).toEqual([expect.stringContaining("timeAgo() reads Date.now()")]);
});

test("leaves unguarded browser reads alone: they fail the server render, so the component cannot be server-rendered", async () => {
  const root = libraryWorkspace({
    "packages/ui/src/viewport.ts": `import { ref } from "vue";
export function useViewport() {
  const width = ref(window.innerWidth);
  return { width };
}
`,
  });

  expect(await ssrDiagnostics(root)).toEqual([]);
});

test(`the ${ssrRules} Rules keep running in a single-package Vue SSR project`, async () => {
  const root = fixture({
    "package.json": JSON.stringify({
      name: "ssr-app",
      dependencies: { vue: "^3.5.0", "@vue/server-renderer": "^3.5.0" },
    }),
    "src/clock.ts": legacyClock,
  });

  const result = await runViteDoctor({ root, cache: false, extends: ["vite-doctor/vue/strict"] });

  expect(
    result.diagnostics
      .filter((item) => item.ruleId === "vue/ssr/no-random-or-local-time-render")
      .map((item) => item.file.slice(root.length + 1)),
  ).toEqual(["src/clock.ts"]);
});

test("tracks first-render values by binding, selected property and execution", async () => {
  const root = libraryWorkspace({
    "packages/ui/src/provenance.ts": `import { defineComponent, h, ref as vueRef, onMounted, computed, watch as ref } from "vue";
import * as Vue from "vue";
function readLayout() { return { width: typeof window === 'undefined' ? 0 : window.innerWidth, defaultWidth: 320 } }
function readDefault(_window: unknown) { return 320 }
function useViewport() { return vueRef(typeof window === 'undefined' ? 0 : window.innerWidth) }
function timeAgo(at: number, now = Date.now()) { return String(now - at) }
export default defineComponent({ setup() {
  const a = vueRef(typeof window === 'undefined' ? 0 : window.innerWidth)
  const b = Vue.ref(typeof window === 'undefined' ? 0 : window.innerWidth)
  const stored = readLayout()
  const safe = vueRef(stored.defaultWidth)
  const unsafe = vueRef(stored.width)
  const ignored = vueRef(readDefault(typeof window === 'undefined' ? undefined : window))
  let width = 320
  const captured = vueRef(width)
  if (typeof window !== 'undefined') width = window.innerWidth
  let value = 320
  if (typeof window !== 'undefined') { let value = 1; value = window.innerWidth }
  const outer = vueRef(value)
  const lazy = computed(() => typeof window === 'undefined' ? 0 : window.innerWidth)
  const mounted = Vue.ref(false)
  onMounted(() => { mounted.value = true; useViewport() })
  return () => h('div', { onClick: () => lazy.value }, [a.value, b.value, unsafe.value,
    mounted.value ? timeAgo(0) : 'stable', 'ready'.toLocaleString()])
} })`,
  });
  const diagnostics = await ssrDiagnostics(root);
  expect(diagnostics).toEqual([
    "vue/ssr/no-setup-state-from-browser-read:packages/ui/src/provenance.ts:12",
    "vue/ssr/no-setup-state-from-browser-read:packages/ui/src/provenance.ts:8",
    "vue/ssr/no-setup-state-from-browser-read:packages/ui/src/provenance.ts:9",
  ]);
});

test("traces consumed helper inputs and selected return properties only", async () => {
  const root = libraryWorkspace({
    "packages/ui/src/layout.ts": `export const imported = (value = 320) => value;
export const layout = (width: number) => ({ nested: { width, fallback: 320 } });`,
    "packages/ui/src/inputs.ts": `import { defineComponent, h, ref } from 'vue';
import { imported, layout } from './layout';
function identity(value = 320) { return value }
function pass(value: number) { return value }
function forward(value: number) { return pass(value) }
function readDefault(value = typeof window === 'undefined' ? 0 : window.innerWidth) { return value }
function select(value: { width: number, fallback: number }) { return value.fallback }
export default defineComponent({ setup() {
  const browser = typeof window === 'undefined' ? 0 : window.innerWidth;
  const a = ref(identity(browser));
  const b = ref(imported(browser));
  const c = ref(forward(browser));
  const d = ref(readDefault());
  const e = ref(readDefault(320));
  const f = ref(layout(browser).nested.fallback);
  const g = ref(layout(browser).nested.width);
  const i = ref(select({ width: browser, fallback: 320 }));
  const j = ref(readDefault(undefined));
  const { fallback } = { width: browser, fallback: 320 };
  const k = ref(fallback);
  function pick({ fallback }: { width: number, fallback: number }) { return fallback }
  const l = ref(pick({ width: browser, fallback: 320 }));
  return () => h('div', [a, b, c, d, e, f, g, i, j, k, l].map(x => x.value));
} });`,
  });
  expect(await ssrDiagnostics(root)).toEqual(
    [10, 11, 12, 13, 16, 18].map(
      (line) => `vue/ssr/no-setup-state-from-browser-read:packages/ui/src/inputs.ts:${line}`,
    ),
  );
});

test("preserves a browser selector only when it changes the selected property", async () => {
  const root = libraryWorkspace({
    "packages/ui/src/branches.ts": `import { defineComponent, h, ref } from 'vue';
const different = () => typeof window !== 'undefined' && window.innerWidth >= 768
  ? { nested: { columns: 2 } } : { nested: { columns: 1 } };
export default defineComponent({ setup() {
  const wide = typeof window !== 'undefined' && window.innerWidth >= 768;
  const layout = typeof window !== 'undefined' && window.innerWidth >= 768 ? { columns: 2 } : { columns: 1 };
  const shortCircuit = (typeof window !== 'undefined' && window.innerWidth >= 768 && { columns: 2 }) || { columns: 1 };
  const stable = wide ? { columns: 1, width: globalThis.window?.innerWidth } : { columns: 1 };
  const stableShortCircuit = (wide && { columns: 1, width: globalThis.window?.innerWidth }) || { columns: 1 };
  const a = ref(layout.columns);
  const b = ref(shortCircuit.columns);
  const c = ref(different().nested.columns);
  const d = ref(stable.columns);
  const e = ref(stableShortCircuit.columns);
  const f = ref(({ columns: 1, width: globalThis.window?.innerWidth } || { columns: 2 }).columns);
  return () => h('div', [a.value, b.value, c.value, d.value, e.value, f.value]);
} });`,
  });
  expect(await ssrDiagnostics(root)).toEqual(
    [10, 11, 12].map(
      (line) => `vue/ssr/no-setup-state-from-browser-read:packages/ui/src/branches.ts:${line}`,
    ),
  );
});

test("only compares reachable projected values when a guard repeats", async () => {
  const root = libraryWorkspace({
    "packages/ui/src/repeated-guards.ts": `import { defineComponent, h, ref } from 'vue';
export default defineComponent({ setup() {
  const wide = typeof window !== 'undefined' && window.innerWidth >= 768;
  const stable = (wide && { columns: 2 }) || (wide ? { columns: 1 } : { columns: 2 });
  const changing = (wide && { columns: 2 }) || (wide ? { columns: 2 } : { columns: 1 });
  const a = ref(stable.columns);
  const b = ref(changing.columns);
  return () => h('div', [a.value, b.value]);
} });`,
  });
  expect(await ssrDiagnostics(root)).toEqual([
    "vue/ssr/no-setup-state-from-browser-read:packages/ui/src/repeated-guards.ts:7",
  ]);
});

test("traces browser-derived properties beside compound predicates", async () => {
  const root = libraryWorkspace({
    "packages/ui/src/compound-predicates.ts": `import { defineComponent, h, ref } from 'vue';
export default defineComponent({ setup(props) {
  const layout = props.fixed
    ? ((props.a && props.b) || (props.c && props.d) || (props.e && props.f) || (props.g && props.h)
      ? { columns: 2 } : { columns: 1 })
    : { columns: globalThis.window?.innerWidth ?? 320 };
  const columns = ref(layout.columns);
  return () => h('div', String(columns.value));
} });`,
  });
  expect(await ssrDiagnostics(root)).toEqual([
    "vue/ssr/no-setup-state-from-browser-read:packages/ui/src/compound-predicates.ts:7",
  ]);
});

test("resolves template reads outside loop and slot aliases", async () => {
  const root = libraryWorkspace({
    "packages/ui/src/Scopes.vue": `<script setup lang="ts">
import { computed, onMounted } from 'vue';
const loopWidth = computed(() => typeof window === 'undefined' ? 0 : window.innerWidth);
const slotWidth = computed(() => typeof window === 'undefined' ? 0 : window.innerWidth);
const widths = computed(() => typeof window === 'undefined' ? [] : [window.innerWidth]);
const visible = computed(() => typeof window === 'undefined' ? false : window.innerWidth > 0);
const siblingWidth = computed(() => typeof window === 'undefined' ? 0 : window.innerWidth);
const propWidth = computed(() => typeof window === 'undefined' ? 0 : window.innerWidth);
onMounted(() => console.log(loopWidth.value, slotWidth.value));
</script>
<template>
  <p v-for="loopWidth in [320]" :key="loopWidth"><i>{{ loopWidth }}</i></p>
  <Panel v-slot="{ width: slotWidth }"><i>{{ slotWidth }}</i></Panel>
  <Panel v-slot="{ width: propWidth }" :width="propWidth">{{ propWidth }}</Panel>
  <p v-for="widths in widths" :key="widths">{{ widths }}</p>
  <p v-if="visible" v-for="visible in [1]" :key="visible">{{ visible }}</p>
  <p v-for="siblingWidth in [320]" :key="siblingWidth">{{ siblingWidth }}</p>
  <p>{{ siblingWidth }}</p>
</template>`,
  });
  expect(await ssrDiagnostics(root)).toEqual(
    [5, 6, 7, 8].map(
      (line) => `vue/ssr/no-setup-state-from-browser-read:packages/ui/src/Scopes.vue:${line}`,
    ),
  );
});

test("does not treat an unused computed declaration as a first-render read", async () => {
  const root = libraryWorkspace({
    "packages/ui/src/lazy.ts": `import { computed, defineComponent, h } from 'vue';
export default defineComponent({ setup() {
  const unused = computed(() => typeof window === 'undefined' ? 0 : window.innerWidth);
  return () => h('div', 'stable');
} });`,
    "packages/ui/src/Lazy.vue": `<script setup lang="ts">
import { computed } from 'vue';
const clickOnly = computed(() => typeof window === 'undefined' ? 0 : window.innerWidth);
const rendered = computed(() => typeof window === 'undefined' ? 0 : window.innerWidth);
</script>
<template><button @click="console.log(clickOnly)">{{ rendered }}</button></template>`,
  });
  expect(await ssrDiagnostics(root)).toEqual([
    "vue/ssr/no-setup-state-from-browser-read:packages/ui/src/Lazy.vue:4",
  ]);
});

test("direct library evidence stays package-owned and browser entry exclusions survive", async () => {
  const root = fixture({
    "package.json": JSON.stringify({
      name: "library",
      exports: { "./nuxt": "./nuxt.js" },
      dependencies: { vue: "^3.5.0" },
    }),
    "src/component.vue": `<script setup>const width = ref(typeof window === 'undefined' ? 0 : window.innerWidth)</script><template>{{ width }}</template>`,
    "src/helper.ts": `export function readViewportOnClick() { return window.innerWidth }`,
  });
  expect((await detectProject(root)).ssr).toBe(false);
  expect(await ssrDiagnostics(root)).toHaveLength(1);
  writeFileSync(
    join(root, "src/main.ts"),
    `import { createApp } from 'vue'; createApp({}).mount('#app')`,
  );
  expect(await ssrDiagnostics(root)).toEqual([]);
});

test("rejects unrelated, shadowed and type-only Vue imports", async () => {
  const root = libraryWorkspace({
    "packages/ui/src/other.ts": `import { watch as ref, defineComponent } from 'vue';
export default defineComponent({ setup() { const x = ref(typeof window === 'undefined' ? 0 : window.innerWidth); return () => x } })`,
    "packages/ui/src/shadow.ts": `import { ref, defineComponent } from 'vue';
export default defineComponent({ setup() { const ref = (x: unknown) => x; return ref(typeof window === 'undefined' ? 0 : window.innerWidth) } })`,
    "packages/ui/src/types.ts": `import type { ref } from 'vue';
export function useState() { return ref(typeof window === 'undefined' ? 0 : window.innerWidth) }`,
  });
  expect(await ssrDiagnostics(root)).toEqual([]);
});

test("keeps initial-render computed values, reaching writes and ungated clocks", async () => {
  const root = libraryWorkspace({
    "packages/ui/src/initial.ts": `import { defineComponent, computed as derive, ref as state, h, onMounted } from 'vue';
function timeAgo(now = Date.now()) { return String(now) }
export default defineComponent({ setup() {
  let width = 320;
  if (typeof window !== 'undefined') width = window.innerWidth;
  const size = state(width);
  const lazy = derive(() => typeof window === 'undefined' ? 0 : window.innerWidth);
  const mounted = state(true);
  onMounted(() => { mounted.value = true });
  return () => h('div', [size.value, lazy.value, mounted.value ? timeAgo() : 'stable']);
} })`,
  });
  expect(await ssrDiagnostics(root)).toEqual([
    "vue/ssr/no-random-or-local-time-render:packages/ui/src/initial.ts:10",
    "vue/ssr/no-setup-state-from-browser-read:packages/ui/src/initial.ts:6",
    "vue/ssr/no-setup-state-from-browser-read:packages/ui/src/initial.ts:7",
  ]);
});
