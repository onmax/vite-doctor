import { describe, expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import * as pinia from "../../../src/rule-packs/pinia/index.ts";

const rule = (pinia as Record<string, any>).noCircularSetupStateRead;

function run(files: Record<string, string>, dependencies: Record<string, string> = {}) {
  return runProjectFixture({
    dependencies: { pinia: "^3.0.0", ...dependencies },
    rules: [rule],
    files,
  });
}

// The X/Y example from https://pinia.vuejs.org/cookbook/composing-stores.html
const x = `import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useYStore } from './y'

export const useXStore = defineStore('x', () => {
  const y = useYStore()
  y.name
  return { name: ref('I am X') }
})
`;

const y = `import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useXStore } from './x'

export const useYStore = defineStore('y', () => {
  const x = useXStore()
  x.name
  return { name: ref('I am Y') }
})
`;

describe("pinia/stores/no-circular-setup-state-read", () => {
  test("reports setup stores that read each other's state at the top level", async () => {
    const result = await run({ "src/stores/x.ts": x, "src/stores/y.ts": y });
    expect(result.diagnostics).toHaveLength(1);
    const [diagnostic] = result.diagnostics;
    expect(diagnostic).toMatchObject({
      code: "PINIA0003",
      ruleId: "pinia/stores/no-circular-setup-state-read",
      severity: "error",
      confidence: "heuristic-high",
      range: { line: 7, column: 3 },
    });
    expect(diagnostic!.file.endsWith("src/stores/x.ts")).toBe(true);
    expect(diagnostic!.related).toEqual([
      expect.objectContaining({
        file: expect.stringMatching(/src\/stores\/y\.ts$/),
        range: expect.objectContaining({ line: 7, column: 3 }),
      }),
    ]);
    expect(diagnostic!.why).toContain('"x"');
    expect(diagnostic!.why).toContain('"y"');
    expect(diagnostic!.why).toContain("src/stores/y.ts:7:3");
    expect(diagnostic!.diagnostic.fix).toContain("computed()");
    expect(diagnostic!.diagnostic.sources).toEqual(["src/stores/x.ts:7:3", "src/stores/y.ts:7:3"]);
  });

  test("reports storeToRefs, destructuring, and direct calls, with every read related", async () => {
    const result = await run({
      "src/stores/cart.ts": `import { defineStore, storeToRefs } from 'pinia'
import { useUserStore } from '@/stores/user'
export const useCartStore = defineStore('cart', () => {
  const user = useUserStore()
  const { name } = storeToRefs(user)
  const greeting = 'Hi ' + user.name
  return { items: [], name, greeting }
})
`,
      "src/stores/user.ts": `import { defineStore } from 'pinia'
import { useCartStore } from './cart.js'
export const useUserStore = defineStore('user', () => {
  const { items } = useCartStore()
  return { name: 'Ada', items }
})
`,
    });
    expect(result.diagnostics).toHaveLength(1);
    const [diagnostic] = result.diagnostics;
    expect(diagnostic!.range).toMatchObject({ line: 5, column: 20 });
    expect(diagnostic!.related?.map((item) => item.range?.line)).toEqual([6, 4]);
  });

  test("reports cycles through three stores and stores in one file", async () => {
    const result = await run({
      "src/stores/a.ts": `import { useBStore } from './b'
export const useAStore = defineStore('a', () => {
  const b = useBStore()
  return { label: b.label }
})
`,
      "src/stores/b.ts": `import { useCStore } from './c'
export const useBStore = defineStore('b', () => {
  const c = useCStore()
  return { label: c.label }
})
`,
      "src/stores/c.ts": `import { useAStore } from './a'
export const useCStore = defineStore('c', () => {
  return { label: useAStore().label }
})
`,
      "src/stores/pair.ts": `import { defineStore } from 'pinia'
export const useLeftStore = defineStore('left', () => {
  const right = useRightStore()
  return { value: right.value }
})
export const useRightStore = defineStore('right', () => {
  const left = useLeftStore()
  return { value: left.value }
})
`,
    });
    expect(result.diagnostics).toHaveLength(2);
    const [cycle, pair] = result.diagnostics.toSorted((a, b) => a.file.localeCompare(b.file));
    expect(cycle!.related).toHaveLength(2);
    expect(cycle!.why).toMatch(/"a".*"b".*"c"/s);
    expect(pair!.related).toHaveLength(1);
  });

  test("matches auto-imported stores by name with lower confidence and says so", async () => {
    const result = await run(
      {
        "stores/x.ts":
          "export const useXStore = defineStore('x', () => {\n  const y = useYStore()\n  y.name\n  return { name: ref('I am X') }\n})\n",
        "stores/y.ts":
          "export const useYStore = defineStore('y', () => {\n  const x = useXStore()\n  x.name\n  return { name: ref('I am Y') }\n})\n",
      },
      { "@pinia/nuxt": "^0.11.0" },
    );
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: "PINIA0003",
      confidence: "heuristic-medium",
    });
    expect(result.diagnostics[0]!.why).toContain("auto-import");
  });

  test("ignores deferred reads and genuinely one-way initialization", async () => {
    const result = await run({
      // (a) the same stores reading each other only inside computed() and actions
      "src/stores/x.ts": `import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useYStore } from './y'
export const useXStore = defineStore('x', () => {
  const y = useYStore()
  const name = ref('I am X')
  const summary = computed(() => \`\${name.value} knows \${y.name}\`)
  async function sync() {
    await Promise.resolve()
    return y.name
  }
  function observe() { return y.name }
  y.$subscribe(() => {})
  return { name, summary, sync }
})
`,
      "src/stores/y.ts": `import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useXStore } from './x'
export const useYStore = defineStore('y', () => {
  const x = useXStore()
  const name = ref('I am Y')
  function greet() {
    return x.name
  }
  const shout = computed(() => x.name.toUpperCase())
  return { name, greet, shout }
})
`,
      // (b) a one-way top-level read
      "src/stores/settings.ts": `import { defineStore } from 'pinia'
import { useSessionStore } from './session'
export const useSettingsStore = defineStore('settings', () => {
  const session = useSessionStore()
  return { locale: session.locale }
})
`,
      "src/stores/session.ts": `import { defineStore } from 'pinia'
import { computed } from 'vue'
export const useSessionStore = defineStore('session', () => {
  return { locale: 'en' }
})
`,
      // (c) option stores using each other in getters and actions
      "src/stores/cart.ts": `import { defineStore } from 'pinia'
import { useUserStore } from './user'
export const useCartStore = defineStore('cart', {
  state: () => ({ items: [] as string[] }),
  getters: {
    summary(state) {
      const user = useUserStore()
      return \`Hi \${user.name}, you have \${state.items.length} items\`
    },
  },
})
`,
      "src/stores/user.ts": `import { defineStore } from 'pinia'
import { useCartStore } from './cart'
export const useUserStore = defineStore('user', {
  state: () => ({ name: 'Ada' }),
  actions: {
    clear() {
      const cart = useCartStore()
      cart.items = []
    },
  },
})
`,
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("reports only the eager read when a deferred read still leaves both calls eager", async () => {
    const result = await run({
      "stores/x.ts": x,
      "stores/y.ts": y.replace("  x.name", "  const later = () => x.name"),
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      file: expect.stringMatching(/stores\/x\.ts$/),
      related: [],
    });
  });

  test.each([
    ["watch source", "import { watch as observe } from 'vue'", "observe(() => x.name, () => {})"],
    ["watchEffect", "import * as Vue from 'vue'", "Vue.watchEffect(() => x.name)"],
    ["immediate invocation", "", ";(() => x.name)()"],
    ["$state", "", "x.$state.name"],
    ["aliased ref extraction", "import { storeToRefs as refs } from 'pinia'", "refs(x)"],
    ["namespace ref extraction", "import * as Vue from 'vue'", "Vue.toRefs(x)"],
  ])("reports eager reads through %s", async (_case, imports, read) => {
    const result = await run({
      "stores/x.ts": x,
      "stores/y.ts": `${imports}\n${y.replace("  x.name", `  ${read}`)}`,
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.related).toHaveLength(1);
  });

  test("ignores shadowed ref helpers and deferred watch callbacks", async () => {
    const result = await run({
      "stores/x.ts": x.replace(
        "  y.name",
        "  const toRefs = (_store: unknown) => ({})\n  toRefs(y)",
      ),
      "stores/y.ts": `import { watch, watchEffect } from 'vue'\n${y.replace("  x.name", "  watch(() => 1, () => x.name)\n  watchEffect(() => x.name, { flush: 'post' })")}`,
    });
    expect(result.diagnostics).toEqual([]);
  });

  test.each([false, true])(
    "checks SSR-compatible creation and read paths (overlap: %s)",
    async (overlap) => {
      const result = await run({
        "stores/x.ts": x.replace(
          "  const y = useYStore()\n  y.name",
          "  if (import.meta.env.SSR) useYStore().name",
        ),
        "stores/y.ts": y.replace(
          "  const x = useXStore()\n  x.name",
          `  if (${overlap ? "" : "!"}import.meta.env.SSR) useXStore().name`,
        ),
      });
      expect(result.diagnostics).toHaveLength(overlap ? 1 : 0);
    },
  );

  test("only reports reads in the runtime that can complete the cycle", async () => {
    const result = await run({
      "stores/x.ts": x.replace("  y.name", "  if (import.meta.env.SSR) y.name"),
      "stores/y.ts": y.replace(
        "  const x = useXStore()\n  x.name",
        "  if (!import.meta.env.SSR) useXStore().name",
      ),
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      file: expect.stringMatching(/stores\/y\.ts$/),
      related: [],
    });
  });

  test.each(["direct", "barrel", "unresolved", "private auto-import"])(
    "does not substitute an unrelated store for a %s binding",
    async (kind) => {
      const result = await run({
        "stores/x.ts": x.replace(
          "import { useYStore } from './y'",
          {
            direct: "import { useYStore } from './y'",
            barrel: "import { useYStore } from './index'",
            unresolved: "import { useYStore } from './missing'",
            "private auto-import": "",
          }[kind]!,
        ),
        "stores/y.ts":
          y.replace("export const useYStore", "const useYStore") +
          "\nexport const helper = () => ({ name: 'helper' })\nexport { helper as useYStore }\n",
        "stores/index.ts": "export { helper as useYStore } from './y'\n",
      });
      expect(result.diagnostics).toEqual([]);
    },
  );

  test("resolves aliased store exports through a barrel", async () => {
    const result = await run({
      "stores/x.ts": x.replace("from './y'", "from './index'"),
      "stores/y.ts":
        y.replace("export const useYStore", "const privateStore") +
        "\nexport { privateStore as exportedStore }\n",
      "stores/barrel.ts": "export { exportedStore as useYStore } from './y'\n",
      "stores/index.ts": "export * from './barrel'\n",
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.confidence).toBe("heuristic-high");
  });

  test("ignores unresolved, shadowed, and ambiguous store calls", async () => {
    const result = await run({
      "apps/web/package.json": "{}",
      "apps/web/stores/user.ts":
        "export const useUserStore = defineStore('user', () => ({ name: useAStore().value }))\n",
      "apps/admin/package.json": "{}",
      "apps/admin/stores/user.ts":
        "export const useUserStore = defineStore('admin-user', () => ({ name: useAStore().value }))\n",
      "src/stores/a.ts": `import { useBStore } from 'some-package'
export const useAStore = defineStore('a', (useCStore: any) => {
  const b = useBStore()
  const c = useCStore()
  const user = useUserStore()
  return { value: b.value + c.value + user.name }
})
`,
      "src/stores/b.ts":
        "export const useBStore = defineStore('b', () => ({ value: useAStore().value }))\n",
      "src/stores/c.ts":
        "export const useCStore = defineStore('c', () => ({ value: useAStore().value }))\n",
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("runs in the recommended preset", () => {
    expect(pinia.piniaRulePack.presets.recommended).toContain(
      "pinia/stores/no-circular-setup-state-read",
    );
  });
});
