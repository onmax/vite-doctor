import { describe, expect, test } from "vite-plus/test";
import type { DoctorRule } from "../../../src/core/index.ts";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import * as pinia from "../../../src/rule-packs/pinia/index.ts";

function run(rule: DoctorRule, files: Record<string, string>) {
  return runProjectFixture({
    dependencies: { pinia: "^3.0.0", vue: "^3.5.0" },
    rules: [rule],
    files,
  });
}

function runNuxt(rule: DoctorRule, files: Record<string, string>) {
  return runProjectFixture({
    framework: "nuxt",
    dependencies: { pinia: "^3.0.0", "@pinia/nuxt": "^0.11.0" },
    rules: [rule],
    files,
  });
}

const counterSetup = `import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export const useCounterStore = defineStore('counter', () => {
  const count = ref(0)
  const doubleCount = computed(() => count.value * 2)
  function increment() {
    count.value++
  }
  return { count, doubleCount, increment }
})
`;

const counterOptions = `import { defineStore } from 'pinia'

export const useCounterStore = defineStore('counter', {
  state: () => ({ count: 0 }),
  getters: { doubleCount: (state) => state.count * 2 },
  actions: {
    increment() {
      this.count++
    },
  },
})
`;

const component = (body: string, imports = "") => `<script setup lang="ts">
import { useCounterStore } from '../stores/counter'
${imports}
${body}
</script>
<template><p>{{ count }}</p></template>
`;

describe("pinia/state/no-store-destructure", () => {
  const rule = pinia.noStoreDestructure;

  test.each([
    ["setup store", counterSetup],
    ["option store", counterOptions],
  ])("reports state and getters destructured from a %s", async (_, store) => {
    const result = await run(rule, {
      "stores/counter.ts": store,
      "components/Counter.vue": component(
        "const { count, doubleCount, increment } = useCounterStore()",
      ),
    });
    expect(result.diagnostics.map((item) => item.code)).toEqual(["PINIA0005"]);
    expect(result.diagnostics[0]!.why).toContain('"count" (state), "doubleCount" (getter)');
    expect(result.diagnostics[0]!.diagnostic.fix).toContain("increment");
  });

  test("reports destructuring a store binding inside a setup store", async () => {
    const result = await run(rule, {
      "stores/counter.ts": counterSetup,
      "stores/summary.ts": `import { defineStore } from 'pinia'
import { useCounterStore } from './counter'

export const useSummaryStore = defineStore('summary', () => {
  const counter = useCounterStore()
  const { count } = counter
  return { count }
})
`,
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.file).toMatch(/summary\.ts$/);
  });

  test.each([
    [
      "storeToRefs",
      "const { count, doubleCount } = storeToRefs(useCounterStore())",
      "import { storeToRefs } from 'pinia'",
    ],
    ["actions only", "const { increment } = useCounterStore()", ""],
    ["a key the store does not declare", "const { $id, unknownKey } = useCounterStore()", ""],
    [
      "an event handler",
      "function read() {\n  const { count } = useCounterStore()\n  return count\n}",
      "",
    ],
  ])("stays quiet for %s", async (_, body, imports) => {
    const result = await run(rule, {
      "stores/counter.ts": counterSetup,
      "components/Counter.vue": component(body, imports),
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("records an evidence gap when the store's keys cannot be read", async () => {
    const result = await run(rule, {
      "stores/counter.ts": `import { defineStore } from 'pinia'
import { ref } from 'vue'
import { shared } from './shared'

export const useCounterStore = defineStore('counter', () => {
  const count = ref(0)
  return { count, ...shared() }
})
`,
      "stores/shared.ts": "export const shared = () => ({})",
      "components/Counter.vue": component("const { total } = useCounterStore()"),
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.project.evidenceGaps?.[0]?.message).toContain('store "counter"');
  });
});

describe("pinia/stores/no-module-scope-store", () => {
  const rule = pinia.noModuleScopeStore;

  test("reports a store called at the top level of a module", async () => {
    const result = await run(rule, {
      "stores/counter.ts": counterSetup,
      "router/guard.ts": `import { useCounterStore } from '../stores/counter'

const counter = useCounterStore()

export function guard() {
  return counter.count > 0
}
`,
    });
    expect(result.diagnostics.map((item) => item.code)).toEqual(["PINIA0006"]);
    expect(result.diagnostics[0]!.why).toContain("no active Pinia");
  });

  test("reports a store called in an SFC's plain <script> under Nuxt SSR", async () => {
    const result = await runNuxt(rule, {
      "stores/counter.ts": counterSetup,
      "app/pages/index.vue": `<script lang="ts">
import { useCounterStore } from '../../stores/counter'
const counter = useCounterStore()
</script>
<script setup lang="ts">
const value = counter.count
</script>
<template><p>{{ value }}</p></template>
`,
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.why).toContain("every request shares the store");
  });

  test.each([
    ["<script setup>", component("const counter = useCounterStore()")],
    [
      "setup()",
      `<script lang="ts">
import { defineComponent } from 'vue'
import { useCounterStore } from '../stores/counter'
export default defineComponent({
  setup() {
    const counter = useCounterStore()
    return { counter }
  },
})
</script>
`,
    ],
    [
      "a router guard callback",
      `import { useCounterStore } from '../stores/counter'
export const guard = () => useCounterStore().count > 0
`,
    ],
    [
      "an explicit Pinia instance",
      `import { pinia } from './pinia'
import { useCounterStore } from '../stores/counter'
export const counter = useCounterStore(pinia)
`,
    ],
    [
      "an entry that installs Pinia first",
      `import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { useCounterStore } from '../stores/counter'
const app = createApp({})
app.use(createPinia())
export const counter = useCounterStore()
`,
    ],
  ])("stays quiet for %s", async (_, source) => {
    const result = await run(rule, {
      "stores/counter.ts": counterSetup,
      [source.startsWith("<script") ? "components/Counter.vue" : "router/guard.ts"]: source,
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("stays quiet for a same-named function that is not the store", async () => {
    const result = await run(rule, {
      "stores/counter.ts": counterSetup,
      "router/guard.ts": `function useCounterStore() {
  return { count: 0 }
}
export const counter = useCounterStore()
`,
    });
    expect(result.diagnostics).toEqual([]);
  });
});

describe("pinia/stores/no-unreturned-setup-state", () => {
  const rule = pinia.noUnreturnedSetupState;
  const store = (body: string, returned: string) => `import { defineStore } from 'pinia'
import { computed, reactive, ref, watch } from 'vue'

export const useSearchStore = defineStore('search', () => {
${body}
  return ${returned}
})
`;

  test.each([
    [
      "a ref an action writes",
      "  const query = ref('')\n  const results = computed(() => query.value.split(' '))\n  function setQuery(value: string) {\n    query.value = value\n  }",
      "{ results, setQuery }",
    ],
    [
      "a reactive object a watcher writes",
      "  const seen = reactive({ total: 0 })\n  const other = ref(0)\n  watch(other, () => {\n    seen.total++\n  })\n  const total = computed(() => seen.total)",
      "{ other, total }",
    ],
  ])("reports %s but not returned", async (_, body, returned) => {
    const result = await run(rule, { "stores/search.ts": store(body, returned) });
    expect(result.diagnostics.map((item) => item.code)).toEqual(["PINIA0007"]);
  });

  test.each([
    [
      "returned state",
      "  const query = ref('')\n  function setQuery(value: string) {\n    query.value = value\n  }",
      "{ query, setQuery }",
    ],
    [
      "state returned inside a computed()",
      "  const query = ref('')\n  function setQuery(value: string) {\n    query.value = value\n  }",
      "{ query: computed(() => query.value), setQuery }",
    ],
    [
      "a ref only read once during setup",
      "  const initial = ref(1)\n  const count = ref(initial.value)\n  function inc() {\n    count.value++\n  }",
      "{ count, inc }",
    ],
    ["a plain variable", "  let timer = 0\n  function start() {\n    timer = 1\n  }", "{ start }"],
    [
      "a ref that escapes into another object",
      "  const query = ref('')\n  const form = { query }\n  function setQuery(value: string) {\n    query.value = value\n  }",
      "{ form, setQuery }",
    ],
  ])("stays quiet for %s", async (_, body, returned) => {
    const result = await run(rule, { "stores/search.ts": store(body, returned) });
    expect(result.diagnostics).toEqual([]);
  });

  test("records an evidence gap when the return object has an unknown spread", async () => {
    const result = await run(rule, {
      "stores/search.ts": store(
        "  const query = ref('')\n  const extra = () => ({})\n  function setQuery(value: string) {\n    query.value = value\n  }",
        "{ setQuery, ...extra() }",
      ),
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.project.evidenceGaps?.[0]?.message).toContain("query");
  });
});
