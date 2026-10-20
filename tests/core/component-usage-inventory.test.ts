import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { expect, test } from "vite-plus/test";
import {
  allDiagnostics,
  createRule,
  defineDoctorExtension,
  defineRulePack,
  runDoctor,
  type ComponentUsageGraph,
  type DoctorRule,
} from "../../src/core/index.ts";
import { runProjectFixture, runRuleFixture } from "../../src/core/testkit.ts";

function captureGraph(): { rule: DoctorRule; graph: () => ComponentUsageGraph } {
  let captured: ComponentUsageGraph | undefined;
  const rule = createRule({
    meta: {
      id: "test/component-usage",
      title: "Capture component usage",
      category: "architecture",
      severity: "info",
      execution: "workspace",
      cacheScope: "none",
    },
    create(ctx) {
      return {
        async onWorkspaceEnd() {
          captured = await ctx.inventory.componentUsage();
        },
      };
    },
  });
  return {
    rule,
    graph: () => {
      if (!captured) throw new Error("The capture Rule did not run.");
      return captured;
    },
  };
}

function relative(graph: ComponentUsageGraph, root: string) {
  return Object.fromEntries(
    [...graph.components.values()].map((node) => [
      node.relativePath,
      {
        renders: node.renders.map((edge) => ({
          tag: edge.usage.tag,
          target: edge.target?.slice(root.length + 1),
          resolvedBy: edge.resolvedBy,
        })),
        callers: node.callers.map((edge) => edge.from.slice(root.length + 1)),
        indirectImporters: node.indirectImporters.map((file) => file.slice(root.length + 1)),
      },
    ]),
  );
}

const inventoryFiles = {
  "src/App.vue": `<script setup lang="ts">
import UserCard from './components/UserCard.vue'
import { Badge } from './components'
import Dialog from './components/Dialog.vue'
const items = [{ id: 1 }]
const activeId = 1
</script>
<template>
  <user-card v-for="item in items" :key="item.id" :user-id="item.id" :active-id="activeId" v-bind="$attrs" @select="activeId = $event" />
  <Badge label="New" v-model:open="activeId" />
  <component :is="Dialog" />
  <RouterView />
</template>`,
  "src/components/UserCard.vue": `<script setup lang="ts">
interface Base { userId: number }
interface Props extends Base { activeId?: number; 'display-name'?: string }
const { activeId = 0 } = defineProps<Props>()
const emit = defineEmits<{ (e: 'select' | 'close', id: number): void; open: [] }>()
</script>
<template>
  <article :class="{ active: userId === activeId }">{{ displayName }}</article>
</template>`,
  "src/components/Badge.vue": `<script setup>
const props = defineProps({ label: String, tone: { type: String, default: 'info' } })
const open = defineModel('open')
</script>
<template><span>{{ props.label }}</span></template>`,
  "src/components/Dialog.vue": `<template><dialog /></template>`,
  "src/components/index.ts": `export { default as Badge } from './Badge.vue'`,
  "src/main.ts": `import { createApp } from 'vue'
import App from './App.vue'
createApp(App).mount('#app')`,
};

test("component usage graph resolves script setup imports and records what each usage passes", async () => {
  const { rule, graph } = captureGraph();
  const result = await runProjectFixture({ files: inventoryFiles, rules: [rule] });
  const root = result.root;
  const nodes = relative(graph(), root);

  expect(nodes["src/App.vue"]!.renders).toEqual([
    { tag: "user-card", target: "src/components/UserCard.vue", resolvedBy: "import" },
    { tag: "Badge", target: "src/components/Badge.vue", resolvedBy: "import" },
    { tag: "RouterView", target: undefined, resolvedBy: undefined },
  ]);
  expect(nodes["src/components/UserCard.vue"]!.callers).toEqual(["src/App.vue"]);
  expect(nodes["src/App.vue"]!.indirectImporters).toEqual(["src/main.ts"]);
  expect(nodes["src/components/Badge.vue"]!.indirectImporters).toEqual(["src/components/index.ts"]);
  expect(nodes["src/components/Dialog.vue"]!.indirectImporters).toEqual(["src/App.vue"]);
  expect(graph().unresolved.map((edge) => edge.usage.tag)).toEqual(["RouterView"]);

  const card = graph().components.get(join(root, "src/components/UserCard.vue"))!.facts;
  expect(card.props).toEqual([
    expect.objectContaining({ name: "activeId", default: true }),
    expect.objectContaining({ name: "displayName", default: false }),
    expect.objectContaining({ name: "userId", default: false }),
  ]);
  expect(card.propAliases).toEqual({ activeId: "activeId" });
  expect(card.emits).toEqual(["select", "close", "open"]);
  expect(card.emitBinding).toBe("emit");
  expect(card.comparisons).toEqual([{ left: "userId", right: "activeId", in: "template" }]);
  expect(card.ownMarkup).toBe(true);

  const badge = graph().components.get(join(root, "src/components/Badge.vue"))!.facts;
  expect(badge.props).toEqual([
    expect.objectContaining({ name: "label", default: false }),
    expect.objectContaining({ name: "tone", default: true }),
  ]);
  expect(badge.propsBinding).toBe("props");
  expect(badge.models).toEqual([
    expect.objectContaining({ name: "open", binding: "open", default: false }),
  ]);

  const [cardUsage, badgeUsage] = graph().components.get(join(root, "src/App.vue"))!.facts.usages;
  expect(cardUsage).toMatchObject({
    inFor: true,
    scope: ["item"],
    bindings: [
      { name: "key", expression: "item.id" },
      { name: "user-id", expression: "item.id" },
      { name: "active-id", expression: "activeId" },
    ],
    spreads: [{ directive: "bind", expression: "$attrs" }],
    listeners: [{ event: "select", expression: "activeId = $event" }],
  });
  expect(badgeUsage).toMatchObject({
    inFor: false,
    attributes: [{ name: "label", value: "New" }],
    bindings: [{ name: "open", expression: "activeId", model: true }],
  });
});

test("component usage graph is Project Inventory for workspace Rules only", async () => {
  const rule = createRule({
    meta: {
      id: "test/file-component-usage",
      title: "Read component usage from a file Rule",
      category: "architecture",
      severity: "info",
    },
    async create(ctx) {
      await ctx.inventory.componentUsage();
    },
  });
  await expect(
    runRuleFixture({ rule, files: { "src/App.vue": "<template><div /></template>" } }),
  ).rejects.toThrow(/set meta\.execution to "workspace"/);
});

test("Rules that read the component usage graph are not replayed from the cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "vite-doctor-component-cache-"));
  const write = (files: Record<string, string>) => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }
  };
  const callers = createRule({
    meta: {
      id: "test/component-callers",
      title: "Report component callers",
      category: "architecture",
      severity: "info",
      execution: "workspace",
    },
    create(ctx) {
      return {
        async onWorkspaceEnd() {
          const graph = await ctx.inventory.componentUsage();
          const item = graph.components.get(join(root, "src/Item.vue"))!;
          for (const edge of item.callers)
            ctx.report(
              allDiagnostics.DOC9999({
                why: `Item is rendered from ${edge.from}.`,
                fix: "Inspect the component usage fixture.",
              }),
              { file: edge.from, range: edge.usage.range },
            );
        },
      };
    },
  });
  const run = () =>
    runDoctor({
      root,
      framework: "vue",
      cache: true,
      extensions: [
        defineDoctorExtension({
          name: "fixture",
          rulePacks: [
            defineRulePack({
              name: "fixture",
              version: "0.0.0",
              rules: [callers],
              presets: { recommended: [callers.meta.id] },
            }),
          ],
        }),
      ],
    });
  const caller = `<script setup lang="ts">
import Item from './Item.vue'
</script>
<template><Item title="One" /></template>`;
  try {
    write({
      "package.json": JSON.stringify({ type: "module", dependencies: { vue: "^3.5.0" } }),
      "src/Item.vue": `<script setup lang="ts">
defineProps<{ title: string }>()
</script>
<template><h2>{{ title }}</h2></template>`,
      "src/App.vue": caller,
    });
    expect((await run()).diagnostics).toHaveLength(1);
    write({ "src/Other.vue": caller });
    expect((await run()).diagnostics).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
