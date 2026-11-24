import { describe, expect, test } from "vite-plus/test";
import { defineDoctorExtension, type DoctorRule } from "../../../src/core/index.ts";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import * as pinia from "../../../src/rule-packs/pinia/index.ts";

const RULE_ID = "pinia/state/no-action-bypass";
const rule = pinia.noActionBypass;

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

const nuxtWriter = (binding: string, imported = "") =>
  `${imported}\nconst cart = ${binding}()\ncart.items = []`;

function runNuxt(
  files: Record<string, string>,
  autoImports: Array<{ name: string; from: string; as?: string }> | null,
  {
    enabled = true,
    excluded = false,
    transformExcluded = false,
    fixtureRule = rule,
    extensionOrders,
  }: {
    enabled?: boolean;
    excluded?: boolean;
    transformExcluded?: boolean;
    fixtureRule?: DoctorRule;
    extensionOrders?: string[][];
  } = {},
) {
  return runProjectFixture({
    framework: "nuxt",
    dependencies: { pinia: "^3.0.0", "@pinia/nuxt": "^0.11.0" },
    rules: [fixtureRule],
    extensions: extensionOrders && [
      defineDoctorExtension({
        name: "fixture-vite-resolution",
        setup(api) {
          api.registerRuntimeEvidenceContributor({
            name: "vite",
            contribute(project) {
              return {
                importResolution: {
                  root: project.root,
                  environments: extensionOrders.map((extensions) => ({
                    consumer: "client",
                    extensions,
                  })),
                },
              };
            },
          });
        },
      }),
    ],
    config: excluded ? { exclude: ["cart.ts"] } : undefined,
    files: {
      ...(autoImports && {
        ".nuxt/doctor.manifest.json": JSON.stringify({
          generatedAt: "2100-01-01T00:00:00.000Z",
          autoImportEnabled: enabled,
          autoImports,
          ...(transformExcluded && {
            autoImportTransform: { include: [], exclude: [{ source: "generated", flags: "" }] },
          }),
        }),
      }),
      "cart.ts": setupCart,
      ...files,
    },
  });
}

describe(RULE_ID, () => {
  const piniaRuntime = "/fixture/node_modules/@pinia/nuxt/dist/runtime/composables";

  test.each([
    ["defineStore", "", "defineStore", piniaRuntime],
    ["defineStore", "import { defineStore } from '#imports'", "defineStore", piniaRuntime],
    ["makeStore", "", "makeStore", piniaRuntime],
    ["makeStore", "import { defineStore as makeStore } from '#imports'", "defineStore", "pinia"],
  ])("recognizes Nuxt's %s factory with import %s", async (factory, imported, name, from) => {
    const writer = nuxtWriter("useCartStore", "import { useCartStore } from './cart'");
    const result = await runNuxt(
      {
        "cart.ts": optionCart
          .replace("import { defineStore } from 'pinia'", imported)
          .replace("= defineStore(", `= ${factory}(`),
        "a.ts": writer,
        "b.ts": writer,
      },
      [{ name: "defineStore", as: name, from }],
      { enabled: Boolean(!imported) },
    );
    expect(result.diagnostics).toHaveLength(1);
  });

  test.each([
    [piniaRuntime, "", 0],
    [piniaRuntime, "import { defineStore } from '#imports'", 0],
    ["~~/custom", "", 1],
    [piniaRuntime, "const defineStore = (_id, setup) => setup()", 1],
  ])(
    "only excludes dynamic store boundaries with Pinia bindings: %s (%s)",
    async (from, factory, count) => {
      const writer = nuxtWriter("useCartStore", "import { useCartStore } from './cart'");
      const result = await runNuxt(
        {
          "a.ts": writer,
          "b.ts": `import { useCartStore } from './cart'
${factory}
defineStore(String(1), () => { useCartStore().items = [] })`,
        },
        [{ name: "defineStore", from }],
      );
      expect(result.diagnostics).toHaveLength(count);
    },
  );

  test("indexes Nuxt registrations once per resolution context, not per source file", async () => {
    let unrelatedLookups = 0;
    const fixtureRule: DoctorRule = {
      ...rule,
      create(ctx) {
        return rule.create({
          ...ctx,
          fs: {
            ...ctx.fs,
            stat(path) {
              if (path.includes("/unrelated/")) unrelatedLookups++;
              return ctx.fs.stat(path);
            },
          },
        });
      },
    };
    const writer = nuxtWriter("useCartStore");
    const decoys = Array.from({ length: 12 }, (_, index) => `decoy${index}`);
    const result = await runNuxt(
      {
        "a.ts": writer,
        "nested/b.ts": writer,
        ...Object.fromEntries(decoys.map((name) => [`${name}/index.ts`, "export const noop = 0"])),
      },
      [
        { name: "useCartStore", from: "~~/cart" },
        ...decoys.map((name) => ({ name, from: `~~/unrelated/${name}.ts` })),
      ],
      { fixtureRule },
    );
    expect(result.diagnostics).toHaveLength(1);
    expect(unrelatedLookups).toBeLessThan(20 * decoys.length);
  });

  test("resolves relative registrations independently in each caller directory", async () => {
    const writer = nuxtWriter("useCartStore", "import { useCartStore } from '#imports'");
    const result = await runNuxt(
      {
        "a.ts": writer,
        "outside/b.ts": writer,
        "outside/cart.ts": "export const useCartStore = () => ({ items: [] })",
      },
      [{ name: "useCartStore", from: "./cart" }],
    );
    expect(result.diagnostics).toEqual([]);
  });

  test("does not report stores excluded from the Doctor Run", async () => {
    const writer = nuxtWriter("useCartStore", "import { useCartStore } from '#imports'");
    const result = await runNuxt(
      { "a.ts": writer, "b.ts": writer },
      [{ name: "useCartStore", from: "~~/cart" }],
      { excluded: true },
    );
    expect(result.diagnostics).toEqual([]);
  });

  test("counts writes inside ordinary callbacks in a file mentioning defineStore", async () => {
    const result = await run({
      "src/stores/cart.ts": setupCart,
      "src/components/A.vue": a,
      "src/components/B.vue": b
        .replace("</script>", "// defineStore\nonMounted(() => { cart.items = [] })\n</script>")
        .split("<template>")[0]!,
    });
    expect(result.diagnostics[0]?.related).toHaveLength(2);
  });

  test("still ignores writes in a real store with a dynamic id", async () => {
    const result = await run({
      "src/stores/cart.ts": setupCart,
      "src/components/A.vue": a,
      "src/stores/other.ts": `import { defineStore as store } from 'pinia'
import { useCartStore } from './cart'
export const useOtherStore = store(String(1), () => {
  useCartStore().items = []
  return {}
})`,
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("attributes every known root Object.assign key to both the action and the callers", async () => {
    const result = await run({
      "src/stores/cart.ts": optionCart.replace(
        "this.items.push(item)",
        "Object.assign(this, { items: [item] }, { ['total']: 1 })",
      ),
      "src/components/A.ts": `import { useCartStore } from '../stores/cart'
const cart = useCartStore()
Object.assign(cart, { items: [] }, { total: 0 })`,
      "src/components/B.vue": b.replace(
        "cart.items = []",
        "Object.assign(cart, { items: [], total: 0 })",
      ),
    });
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics.map((diagnostic) => diagnostic.related?.length)).toEqual([2, 2]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.why)).toEqual([
      expect.stringContaining('"items"'),
      expect.stringContaining('"total"'),
    ]);
  });

  test("counts property Object.assign writes but not a shadowed template Object", async () => {
    const assign = b.replace("cart.items = []", "Object.assign(cart.items, { 0: 'x' })");
    const result = await run({
      "src/stores/cart.ts": optionCart,
      "src/components/A.vue": a,
      "src/components/B.vue": assign,
      "src/components/C.vue": assign.replace(
        "Object.assign(cart.items, { 0: 'x' })",
        "[helper].forEach(Object => Object.assign(cart.items, {}))",
      ),
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.related?.map((write) => write.file.slice(-5))).toEqual([
      "A.vue",
      "B.vue",
    ]);
  });

  test.each([
    [
      "setup action",
      setupCart.replace("items, total, addItem", "items, total, addItem, ...{ addItem: null }"),
    ],
    [
      "setup state",
      setupCart.replace("items, total, addItem", "items, total, addItem, items: total"),
    ],
    [
      "unknown spread",
      setupCart.replace("items, total, addItem", "items, total, addItem, ...unknown"),
    ],
    [
      "computed key",
      setupCart.replace("items, total, addItem", "items, total, addItem, [unknown]: null"),
    ],
    [
      "option action",
      optionCart.replace(
        "this.items.push(item)\n    },",
        "this.items.push(item)\n    }, ...{ addItem() {} },",
      ),
    ],
    ["option actions block", optionCart.replace("  },\n})", "  },\n  ...{ actions: {} },\n})")],
    [
      "option state block",
      optionCart.replace("  actions:", "  ...{ state: () => ({ total: 0 }) },\n  actions:"),
    ],
  ])("ignores shadowed %s members", async (_, store) => {
    const result = await run({
      "src/stores/cart.ts": store,
      "src/components/A.vue": a,
      "src/components/B.vue": b,
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("uses known members restored after a spread and follows arrow receiver scopes", async () => {
    const result = await run({
      "src/stores/cart.ts": optionCart
        .replace("actions: {", "actions: { ...unknown,")
        .replace("this.items.push(item)", "[item].forEach(() => this.items.push(item))"),
      "src/components/A.vue": a,
      "src/components/B.vue": b,
    });
    expect(result.diagnostics).toHaveLength(1);
  });

  test.each(["this.items = []", "this.$patch({ items: [] })"])(
    "ignores class receiver writes: %s",
    async (write) => {
      const result = await run({
        "src/stores/cart.ts": optionCart.replace(
          "this.items.push(item)",
          `new class { field = (${write}) }()`,
        ),
        "src/components/A.vue": a,
        "src/components/B.vue": b,
      });
      expect(result.diagnostics).toEqual([]);
    },
  );

  test.each([true, false])(
    "follows a registered alias via #imports with transform enabled: %s",
    async (enabled) => {
      const explicit = nuxtWriter("useCart", "import { useBasket as useCart } from '#imports'");
      const result = await runNuxt(
        { "a.ts": explicit, "b.ts": enabled ? nuxtWriter("useBasket") : explicit },
        [{ name: "useCartStore", as: "useBasket", from: "~~/cart" }],
        { enabled },
      );
      expect(result.diagnostics[0]).toMatchObject({ confidence: "heuristic-high" });
      expect(result.diagnostics[0]?.related).toHaveLength(2);
    },
  );

  test.each([
    ["stores/cart.ts", "stores/cart.test.ts"],
    ["stores/cart.ts", "stores/cart.d.ts"],
    ["stores/cart/index.ts", "stores/cart.test.ts"],
    ["stores/cart/index.ts", "stores/cart/index.spec.ts"],
  ])("resolves the Nuxt registration to %s alongside %s", async (store, sibling) => {
    const result = await runNuxt(
      {
        "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['@pinia/nuxt'] })",
        [store]: setupCart,
        [sibling]: "export const useCartStore = () => ({ items: [] })",
        "a.ts": nuxtWriter("useCartStore", "import { useCartStore } from '#imports'"),
        "b.ts": nuxtWriter("useCartStore"),
      },
      [{ name: "useCartStore", from: "~/stores/cart" }],
    );
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.file).toMatch(store);
    expect(result.diagnostics[0]?.related).toHaveLength(2);
  });

  test.each([
    ["cart", ".tsx"],
    ["cart", ".custom.tsx"],
    ["cart", ".test.ts"],
    ["cart/index", ".spec.ts"],
  ])(
    "does not use the default Nuxt store when %s has a configured %s candidate",
    async (path, suffix) => {
      const result = await runNuxt(
        {
          "nuxt.config.ts": `export default defineNuxtConfig({ vite: { resolve: { extensions: ['${suffix}', '.ts'] } } })`,
          [`stores/${path}.ts`]: setupCart,
          [`stores/${path}${suffix}`]: "export const useCartStore = () => ({ items: [] })",
          "a.ts": nuxtWriter("useCartStore", "import { useCartStore } from '#imports'"),
          "b.ts": nuxtWriter("useCartStore"),
        },
        [{ name: "useCartStore", from: "~/stores/cart" }],
      );
      expect(result.project.nuxt?.autoImportsAuthoritative).toBe(true);
      expect(result.diagnostics).toEqual([]);
    },
  );

  test.each([
    { extensionOrders: undefined, count: 0 },
    { extensionOrders: [[".ts", ".test.ts"]], count: 1 },
    { extensionOrders: [[".test.ts", ".ts"]], count: 0 },
    { extensionOrders: [[".ts"], [".test.ts", ".ts"]], count: 0 },
  ])(
    "uses Nuxt extension orders $extensionOrders or leaves a computed override unresolved",
    async ({ extensionOrders, count }) => {
      const result = await runNuxt(
        {
          "nuxt.config.ts": "export default defineNuxtConfig({ vite: customViteOptions })",
          "stores/cart.ts": setupCart,
          "stores/cart.test.ts": "export const useCartStore = () => ({ items: [] })",
          "a.ts": nuxtWriter("useCartStore", "import { useCartStore } from '#imports'"),
          "b.ts": nuxtWriter("useCartStore"),
        },
        [{ name: "useCartStore", from: "~/stores/cart" }],
        { extensionOrders },
      );
      expect(result.project.nuxt?.autoImportsAuthoritative).toBe(true);
      expect(result.diagnostics).toHaveLength(count);
    },
  );

  test("does not guess an explicit #imports binding without a current manifest", async () => {
    const writer = nuxtWriter("useCartStore", "import { useCartStore } from '#imports'");
    const result = await runNuxt({ "a.ts": writer, "b.ts": writer }, null);
    expect(result.diagnostics).toEqual([]);
  });

  test("does not use the Nuxt app transform in excluded files or Nitro", async () => {
    const writer = nuxtWriter("useCartStore");
    const result = await runNuxt(
      {
        "a.ts": writer,
        "generated/b.ts": writer,
        "server/api/c.ts": writer,
        "server/utils/cart.ts": "export const useCartStore = () => ({ items: [] })",
      },
      [{ name: "useCartStore", from: "~~/cart" }],
      { transformExcluded: true },
    );
    expect(result.diagnostics).toEqual([]);
  });

  test.each([true, false])(
    "resolves a custom Nuxt ref rather than assuming Vue (explicit: %s)",
    async (explicit) => {
      const writer = nuxtWriter("useCartStore", "import { useCartStore } from './cart'");
      const result = await runNuxt(
        {
          "cart.ts": setupCart.replace(
            "import { ref } from 'vue'",
            explicit ? "import { ref } from '#imports'" : "",
          ),
          "utils/ref.ts": "export const ref = (value: unknown) => ({ value })",
          "a.ts": writer,
          "b.ts": writer,
        },
        [{ name: "ref", from: "~~/utils/ref" }],
      );
      expect(result.diagnostics).toEqual([]);
    },
  );

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
