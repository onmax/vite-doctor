import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { vueRulePack } from "../../../src/rule-packs/vue/index.ts";
import {
  noPropRelay,
  noUnpassedProps,
  preferStableListProps,
} from "../../../src/rule-packs/vue/rules/vue/index.ts";

test("component inventory Rules are strict-only", () => {
  for (const rule of [noPropRelay, noUnpassedProps, preferStableListProps]) {
    expect(vueRulePack.presets.recommended).not.toContain(rule.meta.id);
    expect(vueRulePack.presets.strict).toContain(rule.meta.id);
  }
});

const relayChild = `<script setup lang="ts">
defineProps<{ title: string; subtitle?: string; tone?: string }>()
defineEmits<{ close: []; save: [value: string] }>()
</script>
<template>
  <section :class="tone"><h2>{{ title }}</h2><p>{{ subtitle }}</p></section>
</template>`;

test("VUE0038 reports a wrapper that only relays props and events to one child", async () => {
  const result = await runRuleFixture({
    rule: noPropRelay,
    files: {
      "src/components/Panel.vue": relayChild,
      "src/components/PanelWrapper.vue": `<script setup lang="ts">
import Panel from './Panel.vue'
const props = defineProps<{ title: string; subtitle?: string; tone?: string }>()
const emit = defineEmits<{ close: []; save: [value: string] }>()
</script>
<template>
  <Panel :title="title" :subtitle="props.subtitle" :tone="tone" @close="emit('close')" @save="(value) => emit('save', value)">
    <template #footer><slot name="footer" /></template>
  </Panel>
</template>`,
      "src/components/SpreadWrapper.vue": `<script setup lang="ts">
import Panel from './Panel.vue'
const props = defineProps<{ title: string; subtitle?: string }>()
</script>
<template><Panel v-bind="props" /></template>`,
    },
  });

  expect(
    result.diagnostics.map((diagnostic) => [
      diagnostic.code,
      diagnostic.file.slice(result.root.length + 1),
      diagnostic.range?.line,
    ]),
  ).toEqual([
    ["VUE0038", "src/components/PanelWrapper.vue", 7],
    ["VUE0038", "src/components/SpreadWrapper.vue", 5],
  ]);
  expect(result.diagnostics[0]!.why).toContain(
    'passes 3 of them (title, subtitle, tone) straight to <Panel> and re-emits "close", "save" from it unchanged',
  );
  expect(result.diagnostics[0]!.suggestion).toContain(
    "provide/inject only for state several descendants share",
  );
  expect(result.diagnostics[0]!.related?.[0]?.file).toBe(
    join(result.root, "src/components/Panel.vue"),
  );
});

test("VUE0038 stays silent for wrappers with markup, logic, defaults, or a package child", async () => {
  const wrapper = (script: string, template: string) => `<script setup lang="ts">
import Panel from './Panel.vue'
${script}
</script>
<template>${template}</template>`;
  const props = "const props = defineProps<{ title: string; subtitle?: string; tone?: string }>()";
  const result = await runRuleFixture({
    rule: noPropRelay,
    files: {
      "src/components/Panel.vue": relayChild,
      "src/components/WithMarkup.vue": wrapper(
        props,
        `<div class="card"><Panel :title="title" :subtitle="subtitle" :tone="tone" /></div>`,
      ),
      "src/components/WithLogic.vue": wrapper(
        `${props}\nconst heading = computed(() => props.title.toUpperCase())`,
        `<Panel :title="heading" :subtitle="subtitle" :tone="tone" />`,
      ),
      "src/components/WithDefaults.vue": wrapper(
        "const { title, subtitle = 'None', tone } = defineProps<{ title: string; subtitle?: string; tone?: string }>()",
        `<Panel :title="title" :subtitle="subtitle" :tone="tone" />`,
      ),
      "src/components/WithStaticProp.vue": wrapper(
        props,
        `<Panel :title="title" :subtitle="subtitle" :tone="tone" variant="primary" />`,
      ),
      "src/components/WithHandler.vue": wrapper(
        `${props}\nconst emit = defineEmits<{ close: [] }>()`,
        `<Panel :title="title" :subtitle="subtitle" :tone="tone" @close="emit('close'); track()" />`,
      ),
      "src/components/MostlyOwn.vue": wrapper(
        "defineProps<{ title: string; a?: string; b?: string; c?: string }>()",
        `<Panel :title="title" :subtitle="a" />`,
      ),
      "src/components/SingleProp.vue": wrapper(
        "defineProps<{ title: string }>()",
        `<Panel :title="title" />`,
      ),
      "src/components/WithIf.vue": wrapper(
        props,
        `<Panel v-if="title" :title="title" :subtitle="subtitle" :tone="tone" />`,
      ),
      "src/components/PackageChild.vue": `<script setup lang="ts">
import { UCard } from '@nuxt/ui'
defineProps<{ title: string; subtitle?: string }>()
</script>
<template><UCard :title="title" :subtitle="subtitle" /></template>`,
      "src/components/TwoChildren.vue": wrapper(
        props,
        `<Panel :title="title" :subtitle="subtitle" :tone="tone"><Panel :title="title" /></Panel>`,
      ),
    },
  });

  expect(result.diagnostics).toEqual([]);
});

test("VUE0038 stays silent for wrappers a library package exports", async () => {
  const result = await runRuleFixture({
    rule: noPropRelay,
    files: {
      "packages/ui/package.json": JSON.stringify({ name: "@acme/ui", exports: "./index.ts" }),
      "packages/ui/Panel.vue": relayChild,
      "packages/ui/PanelWrapper.vue": `<script setup lang="ts">
import Panel from './Panel.vue'
defineProps<{ title: string; subtitle?: string }>()
</script>
<template><Panel :title="title" :subtitle="subtitle" /></template>`,
    },
  });

  expect(result.diagnostics).toEqual([]);
});

const unpassedChild = `<script setup lang="ts">
const { size = 'md' } = defineProps<{ label: string; size?: 'sm' | 'md'; icon?: string; modelValue?: string }>()
</script>
<template><button :class="size">{{ icon }} {{ label }} {{ modelValue }}</button></template>`;

test("VUE0039 reports props that no resolved caller passes", async () => {
  const result = await runRuleFixture({
    rule: noUnpassedProps,
    files: {
      "src/components/ActionButton.vue": unpassedChild,
      "src/pages/Home.vue": `<script setup lang="ts">
import ActionButton from '../components/ActionButton.vue'
</script>
<template><ActionButton label="Save" v-model="draft" /></template>`,
      "src/pages/Settings.vue": `<script setup lang="ts">
import ActionButton from '../components/ActionButton.vue'
</script>
<template><action-button :label="t('reset')" /></template>`,
    },
  });

  expect(
    result.diagnostics.map((diagnostic) => [
      diagnostic.code,
      diagnostic.why.match(/prop "(\w+)"/)?.[1],
    ]),
  ).toEqual([
    ["VUE0039", "size"],
    ["VUE0039", "icon"],
  ]);
  expect(result.diagnostics[0]!.why).toContain("2 usages in 2 files");
  expect(result.diagnostics[0]!.why).toContain("renders with its default value");
  expect(result.diagnostics[0]!.related).toHaveLength(2);
});

test("VUE0039 stays silent when some usage of the component is not visible", async () => {
  const caller = `<script setup lang="ts">
import ActionButton from '../components/ActionButton.vue'
</script>
<template><ActionButton label="Save" /></template>`;
  const cases: Array<Record<string, string>> = [
    {
      "src/pages/Spread.vue": `<script setup lang="ts">
import ActionButton from '../components/ActionButton.vue'
const extra = { size: 'sm' }
</script>
<template><ActionButton label="Save" v-bind="extra" /></template>`,
    },
    {
      "src/main.ts":
        "import ActionButton from './components/ActionButton.vue'\napp.component('ActionButton', ActionButton)",
    },
    { "src/components/index.ts": "export { default as ActionButton } from './ActionButton.vue'" },
    {
      "src/components/ActionButton.stories.ts":
        "import ActionButton from './ActionButton.vue'\nexport default { component: ActionButton, args: { size: 'sm' } }",
    },
    {
      "src/pages/Dynamic.vue": `<script setup lang="ts">
import ActionButton from '../components/ActionButton.vue'
const view = ActionButton
</script>
<template><component :is="view" /></template>`,
    },
    { "src/pages/Global.vue": '<template><ActionButton label="Save" size="sm" /></template>' },
    {
      "src/pages/Prefixed.vue": '<template><FormActionButton label="Save" size="sm" /></template>',
    },
  ];
  for (const files of cases) {
    const result = await runRuleFixture({
      rule: noUnpassedProps,
      files: {
        "src/components/ActionButton.vue": unpassedChild.replace(
          "; icon?: string; modelValue?: string",
          "",
        ),
        "src/pages/Home.vue": caller,
        ...files,
      },
    });
    expect(result.diagnostics, Object.keys(files)[0]).toEqual([]);
  }
});

test("VUE0039 stays silent for components without callers or exported from a package", async () => {
  const result = await runRuleFixture({
    rule: noUnpassedProps,
    files: {
      "src/components/Unused.vue": unpassedChild,
      "packages/ui/package.json": JSON.stringify({ name: "@acme/ui", main: "./index.ts" }),
      "packages/ui/Button.vue": unpassedChild,
      "packages/ui/Toolbar.vue": `<script setup lang="ts">
import Button from './Button.vue'
</script>
<template><Button label="Save" /></template>`,
    },
  });

  expect(result.diagnostics).toEqual([]);
});

const listItem = `<script setup lang="ts">
const props = defineProps<{ id: number; activeId: number | null; label: string }>()
const active = computed(() => props.id === props.activeId)
</script>
<template><li :class="{ active }">{{ label }}</li></template>`;

test("VUE0040 reports a shared list prop the child compares with a per-item prop", async () => {
  const result = await runRuleFixture({
    rule: preferStableListProps,
    files: {
      "src/components/ListItem.vue": listItem,
      "src/components/TemplateItem.vue": `<script setup lang="ts">
defineProps<{ id: number; selectedId?: number }>()
</script>
<template><li :aria-selected="id === selectedId">{{ id }}</li></template>`,
      "src/App.vue": `<script setup lang="ts">
import ListItem from './components/ListItem.vue'
import TemplateItem from './components/TemplateItem.vue'
const activeId = ref<number | null>(null)
const state = reactive({ selectedId: 1 })
</script>
<template>
  <ul>
    <ListItem v-for="item in items" :key="item.id" :id="item.id" :active-id="activeId" :label="item.label" />
  </ul>
  <template v-for="row in rows" :key="row.id">
    <TemplateItem :id="row.id" :selected-id="state.selectedId" />
  </template>
</template>`,
    },
  });

  expect(result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.range?.line])).toEqual(
    [
      ["VUE0040", 9],
      ["VUE0040", 12],
    ],
  );
  expect(result.diagnostics[0]!.suggestion).toContain(':active="item.id === activeId"');
  expect(result.diagnostics[1]!.suggestion).toContain(':selected="row.id === state.selectedId"');
  expect(result.diagnostics[0]!.why).toContain('compares it with its own "id" prop');
});

test("VUE0040 stays silent outside v-for and when the child does not compare the props", async () => {
  const result = await runRuleFixture({
    rule: preferStableListProps,
    files: {
      "src/components/ListItem.vue": listItem,
      "src/components/Plain.vue": `<script setup lang="ts">
defineProps<{ id: number; activeId: number | null }>()
</script>
<template><li>{{ id }} of {{ activeId }}</li></template>`,
      "src/App.vue": `<script setup lang="ts">
import ListItem from './components/ListItem.vue'
import Plain from './components/Plain.vue'
</script>
<template>
  <ListItem :id="current.id" :active-id="activeId" label="Current" />
  <Plain v-for="item in items" :key="item.id" :id="item.id" :active-id="activeId" />
  <ListItem v-for="item in items" :key="item.id" :id="item.id" :active="item.id === activeId" :label="item.label" />
  <ListItem v-for="item in items" :key="item.id" :id="7" :active-id="activeId" :label="item.label" />
</template>`,
    },
  });

  expect(result.diagnostics).toEqual([]);
});
