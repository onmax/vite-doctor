import { describe, expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import * as pinia from "../../../src/rule-packs/pinia/index.ts";

const RULE_ID = "pinia/state/no-action-bypass";
const rule = (pinia as Record<string, any>).noActionBypass;

function run(files: Record<string, string>, dependencies: Record<string, string> = {}) {
  return runProjectFixture({
    dependencies: { pinia: "^3.0.0", vue: "^3.5.0", ...dependencies },
    rules: [rule],
    files,
  });
}

const setupCart = `import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useCartStore = defineStore('cart', () => {
  const items = ref<string[]>([])
  const total = ref(0)
  function addItem(item: string) {
    items.value.push(item)
  }
  return { items, total, addItem }
})
`;

const optionCart = `import { defineStore } from 'pinia'

export const useCartStore = defineStore('cart', {
  state: () => ({ items: [] as string[], total: 0 }),
  actions: {
    addItem(item: string) {
      this.items.push(item)
    },
  },
})
`;

const a = `<script setup lang="ts">
import { useCartStore } from '../stores/cart'
const cart = useCartStore()
function add(x: string) {
  cart.items.push(x)
}
</script>
<template><button @click="add('a')">Add</button></template>
`;

const b = `<script setup lang="ts">
import { useCartStore } from '../stores/cart'
const cart = useCartStore()
</script>
<template><button @click="cart.items = []">Clear</button></template>
`;

describe(RULE_ID, () => {
  test.each([
    ["setup", setupCart, 5],
    ["option", optionCart, 4],
  ])("reports %s store state that two components write past its action", async (_, store, line) => {
    const result = await run({
      "src/stores/cart.ts": store,
      "src/components/A.vue": a,
      "src/components/B.vue": b,
    });
    expect(result.diagnostics).toHaveLength(1);
    const [diagnostic] = result.diagnostics;
    expect(diagnostic).toMatchObject({
      code: "PINIA0004",
      ruleId: RULE_ID,
      severity: "info",
      confidence: "heuristic-high",
      range: expect.objectContaining({ line }),
    });
    expect(diagnostic!.file.endsWith("src/stores/cart.ts")).toBe(true);
    expect(
      diagnostic!.related?.map((item) => [
        item.file.slice(result.root.length + 1),
        item.range?.line,
      ]),
    ).toEqual([
      ["src/components/A.vue", 5],
      ["src/components/B.vue", 5],
    ]);
    expect(diagnostic!.why).toContain("addItem()");
    expect(diagnostic!.why).toContain('"items"');
    expect(diagnostic!.diagnostic.fix).toContain("addItem()");
  });

  test("counts this.$patch() in an action, ++ and v-model in templates", async () => {
    const result = await run({
      "src/stores/counter.ts": `import { defineStore } from 'pinia'
export const useCounterStore = defineStore('counter', {
  state: () => ({ count: 0 }),
  actions: {
    reset() {
      this.$patch({ count: 0 })
    },
  },
})
`,
      "src/components/A.vue": `<script setup lang="ts">
import { useCounterStore } from '../stores/counter'
const counter = useCounterStore()
</script>
<template><button @click="counter.count++">+</button></template>
`,
      "src/components/B.vue": `<script setup lang="ts">
import { useCounterStore } from '../stores/counter'
const counter = useCounterStore()
</script>
<template><input v-model="counter.count"></template>
`,
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.related).toHaveLength(2);
    expect(result.diagnostics[0]!.why).toContain("reset()");
  });

  test("stays quiet when components call the action", async () => {
    const calls = `<script setup lang="ts">
import { useCartStore } from '../stores/cart'
const cart = useCartStore()
</script>
<template><button @click="cart.addItem('a')">Add</button></template>
`;
    const result = await run({
      "src/stores/cart.ts": setupCart,
      "src/components/A.vue": calls,
      "src/components/B.vue": calls,
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("stays quiet when no action writes the property", async () => {
    const result = await run({
      "src/stores/cart.ts": setupCart.replace("items.value.push(item)", "total.value++"),
      "src/components/A.vue": a,
      "src/components/B.vue": b,
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("stays quiet for a single external writer", async () => {
    const result = await run({
      "src/stores/cart.ts": setupCart,
      "src/components/A.vue": a,
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("ignores writes inside the store file and other stores' actions", async () => {
    const checkout = (id: string) => `import { defineStore } from 'pinia'
import { useCartStore } from './cart'

export const use${id}Store = defineStore('${id.toLowerCase()}', {
  actions: {
    clear() {
      const cart = useCartStore()
      cart.items = []
    },
  },
})
`;
    const result = await run({
      "src/stores/cart.ts": `${setupCart}
export function reset() {
  useCartStore().items = []
}
`,
      "src/stores/checkout.ts": checkout("Checkout"),
      "src/stores/orders.ts": checkout("Orders"),
      "src/components/A.vue": a,
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("matches auto-imported stores by name with lower confidence and says so", async () => {
    const result = await run(
      {
        "stores/cart.ts": setupCart.replace(/^import .*\n/gm, ""),
        "components/A.vue": a.replace(/^import .*\n/m, ""),
        "components/B.vue": b.replace(/^import .*\n/m, ""),
      },
      { "@pinia/nuxt": "^0.11.0" },
    );
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: "PINIA0004",
      confidence: "heuristic-medium",
    });
    expect(result.diagnostics[0]!.related).toHaveLength(2);
    expect(result.diagnostics[0]!.why).toContain("auto-import");
  });

  test("does not count $patch() or writes through storeToRefs()", async () => {
    const result = await run({
      "src/stores/cart.ts": setupCart,
      "src/components/A.vue": `<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useCartStore } from '../stores/cart'
const cart = useCartStore()
const { items } = storeToRefs(cart)
items.value = []
</script>
`,
      "src/components/B.vue": `<script setup lang="ts">
import { useCartStore } from '../stores/cart'
const cart = useCartStore()
cart.$patch({ items: [] })
</script>
`,
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("is in the Strict Preset only", () => {
    expect(pinia.piniaRulePack.presets.recommended).not.toContain(RULE_ID);
    expect(pinia.piniaRulePack.presets.strict).toContain(RULE_ID);
  });
});
