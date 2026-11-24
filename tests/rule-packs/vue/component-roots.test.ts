import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { createRule, type ComponentUsageGraph, type DoctorRule } from "../../../src/core/index.ts";
import { runProjectFixture, runRuleFixture } from "../../../src/core/testkit.ts";
import { vueRulePack } from "../../../src/rule-packs/vue/index.ts";
import { noMultiRootFallthrough } from "../../../src/rule-packs/vue/rules/vue/index.ts";

function captureGraph(): { rule: DoctorRule; graph: () => ComponentUsageGraph } {
  let captured: ComponentUsageGraph | undefined;
  const rule = createRule({
    meta: {
      id: "test/component-roots",
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
  return { rule, graph: () => captured! };
}

test("component root facts count a v-if chain as one root and ignore comments", async () => {
  const { rule, graph } = captureGraph();
  const result = await runProjectFixture({
    rules: [rule],
    files: {
      "src/Chain.vue": `<template>
  <!-- loading state -->
  <p v-if="loading">Loading</p>
  <!-- moved into the next branch -->
  <Spinner v-else-if="slow" />
  <template v-else><span>a</span><span>b</span></template>
</template>`,
      "src/Two.vue": `<template>
  <header>title</header>
  <slot />
  <li v-for="item in 3" :key="item">{{ item }}</li>
  text
</template>`,
      "src/Usage.vue": `<script setup lang="ts">
import Two from './Two.vue'
</script>
<template>
  <Two />
  <ul>
    <template v-if="ok"><Two /></template>
  </ul>
  <Card><template #default><Two /></template></Card>
</template>`,
    },
  });
  const facts = (file: string) => graph().components.get(join(result.root, file))!.facts;

  expect(facts("src/Chain.vue").rootNodes).toBe(1);
  expect(
    facts("src/Chain.vue").roots.map((root) => root.branches.map(({ kind, tag }) => [kind, tag])),
  ).toEqual([
    [
      ["element", "p"],
      ["component", "Spinner"],
      ["fragment", undefined],
    ],
  ]);
  expect(facts("src/Two.vue").rootNodes).toBe(4);
  expect(
    facts("src/Two.vue").roots.map((root) => root.branches.map(({ kind, tag }) => [kind, tag])),
  ).toEqual([
    [["element", "header"]],
    [["slot", undefined]],
    [["fragment", undefined]],
    [["text", undefined]],
  ]);
  expect(
    facts("src/Usage.vue").usages.map((usage) => [usage.tag, usage.parent, usage.wrappers]),
  ).toEqual([
    ["Two", undefined, []],
    ["Two", { tag: "ul", element: true }, []],
    ["Card", undefined, []],
    [
      "Two",
      { tag: "Card", element: false },
      [{ tag: "Card", offset: 144, defaultSlot: true, shadowed: false }],
    ],
  ]);
});

const multiRoot = (script = "", template = "<header>Title</header>\n  <main><slot /></main>") =>
  `<script setup lang="ts">
${script}
</script>
<template>
  ${template}
</template>`;

const caller = (tag: string, usage: string) => `<script setup lang="ts">
import ${tag} from './${tag}.vue'
</script>
<template>
  <div>${usage}</div>
</template>`;

test("VUE0051 is strict-only", () => {
  expect(vueRulePack.presets.recommended).not.toContain(noMultiRootFallthrough.meta.id);
  expect(vueRulePack.presets.strict).toContain(noMultiRootFallthrough.meta.id);
});

test.each(["", ' lang="jsx"'])(
  "the default preset scans Vue attrs imports in JS%s",
  async (lang) => {
    const { rule, graph } = captureGraph();
    const result = await runProjectFixture({
      rules: [rule],
      files: {
        "src/Panel.vue": `<script setup${lang}>
import { useAttrs as readAttrs } from 'vue'
const attrs = readAttrs()
function toggle(event) { return event.type }
${lang ? "const render = (props) => <span>{props.label}</span>" : ""}
</script>
<template><header /><main v-bind="attrs" @click="toggle" /></template>`,
      },
    });
    expect(graph().components.get(join(result.root, "src/Panel.vue"))?.facts.readsAttrs).toBe(true);
  },
);

test("VUE0051 reports fallthrough attributes passed to a multi-root component", async () => {
  const result = await runRuleFixture({
    rule: noMultiRootFallthrough,
    files: {
      "src/Layout.vue": multiRoot("defineProps<{ title?: string }>()\ndefineEmits<{ save: [] }>()"),
      "src/Page.vue": caller(
        "Layout",
        `<Layout title="Home" class="page" :id="pageId" @click="open" @save="save" :key="pageId" ref="layout" />`,
      ),
      "src/Undeclared.vue": multiRoot(),
      "src/Other.vue": caller(
        "Undeclared",
        `<Undeclared data-test="x" @update:model-value="set" />`,
      ),
    },
  });

  expect(
    result.diagnostics
      .map((diagnostic) => [
        diagnostic.code,
        diagnostic.file.slice(result.root.length + 1),
        diagnostic.range?.line,
      ])
      .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
  ).toEqual([
    ["VUE0051", "src/Other.vue", 5],
    ["VUE0051", "src/Page.vue", 5],
  ]);
  const page = result.diagnostics.find((diagnostic) => diagnostic.file.endsWith("Page.vue"))!;
  expect(page.why).toContain("class, id, @click");
  expect(page.why).toContain("2 root nodes");
  expect(page.why).not.toContain("title");
  expect(page.why).not.toContain("save");
  expect(page.related?.[0]?.file).toBe(join(result.root, "src/Layout.vue"));
});

test("VUE0051 stays quiet when Vue can place or was told what to do with the attributes", async () => {
  const result = await runRuleFixture({
    rule: noMultiRootFallthrough,
    files: {
      "src/Single.vue": multiRoot(
        "",
        "<!-- note -->\n  <section><slot /></section>\n  <!-- end -->",
      ),
      "src/Chain.vue": multiRoot(
        "",
        `<p v-if="a">A</p>\n  <!-- b -->\n  <span v-else-if="b">B</span>\n  <div v-else>C</div>`,
      ),
      "src/BindsAttrs.vue": multiRoot("", `<header>Title</header>\n  <main v-bind="$attrs" />`),
      "src/UsesAttrs.vue": multiRoot(
        "import { useAttrs } from 'vue'\nconst attrs = useAttrs()",
        `<header>Title</header>\n  <main v-bind="attrs" />`,
      ),
      "src/NoInherit.vue": multiRoot("defineOptions({ inheritAttrs: false })"),
      "src/OptionsNoInherit.vue": `<script lang="ts">
export default { inheritAttrs: false }
</script>
<script setup lang="ts">
defineProps<{ title?: string }>()
</script>
<template>
  <header>Title</header>
  <main />
</template>`,
      "src/Declared.vue": multiRoot(
        "defineProps<{ userId: number }>()\nconst emit = defineEmits(['select'])\nconst open = defineModel<boolean>('open')",
      ),
      "src/App.vue": `<script setup lang="ts">
import Single from './Single.vue'
import Chain from './Chain.vue'
import BindsAttrs from './BindsAttrs.vue'
import UsesAttrs from './UsesAttrs.vue'
import NoInherit from './NoInherit.vue'
import OptionsNoInherit from './OptionsNoInherit.vue'
import Declared from './Declared.vue'
</script>
<template>
  <Single class="a" />
  <Chain class="a" />
  <BindsAttrs class="a" />
  <UsesAttrs class="a" />
  <NoInherit class="a" />
  <OptionsNoInherit class="a" />
  <Declared :user-id="1" @select="pick" v-model:open="open" />
</template>`,
    },
  });

  expect(result.diagnostics).toEqual([]);
});

test("VUE0051 stays quiet when Doctor cannot read the component's props or emits", async () => {
  const result = await runRuleFixture({
    rule: noMultiRootFallthrough,
    files: {
      "src/types.ts": "export interface Props { title?: string }",
      "src/ImportedProps.vue": multiRoot(
        "import type { Props } from './types'\ndefineProps<Props>()",
      ),
      "src/RuntimeProps.vue": multiRoot("const options = { title: String }\ndefineProps(options)"),
      "src/RuntimeEmits.vue": multiRoot("const events = ['save']\ndefineEmits(events)"),
      "src/OptionsProps.vue": `<script lang="ts">
export default { props: ['title'] }
</script>
<template>
  <header>Title</header>
  <main />
</template>`,
      "src/Dynamic.vue": multiRoot("defineOptions({ inheritAttrs: inherit })"),
      "src/App.vue": `<script setup lang="ts">
import ImportedProps from './ImportedProps.vue'
import RuntimeProps from './RuntimeProps.vue'
import RuntimeEmits from './RuntimeEmits.vue'
import OptionsProps from './OptionsProps.vue'
import Dynamic from './Dynamic.vue'
</script>
<template>
  <ImportedProps title="x" />
  <RuntimeProps title="x" />
  <RuntimeEmits @save="save" />
  <OptionsProps title="x" />
  <Dynamic class="x" />
  <Unresolved class="x" />
</template>`,
    },
  });

  expect(result.diagnostics).toEqual([]);
});

test("VUE0051 matches the VNode keys Vue uses for props, emits and reserved hooks", async () => {
  const result = await runRuleFixture({
    rule: noMultiRootFallthrough,
    files: {
      "src/Panel.vue": multiRoot(
        "defineProps(['onClickOnce', 'onContextmenu'])\ndefineEmits(['save', 'Foo', 'item-ready'])",
      ),
      "src/App.vue": caller(
        "Panel",
        `<Panel :onSave="save" onSaveOnce="save" :onVnodeMounted="mounted"
          @click.once="click" @click.right="right" @foo="foo" @item-ready.once="ready"
          @vue:mounted="mounted" @vue:foo="foo" @save.capture="save" />`,
      ),
    },
  });
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.why).toContain("@vue:foo, @save.capture");
  expect(result.diagnostics[0]?.why).not.toMatch(
    /onSave|onVnodeMounted|@click|@item-ready|@foo|@vue:mounted/,
  );
});

test("VUE0051 distinguishes missing DOM inheritance from component event delivery", async () => {
  const result = await runRuleFixture({
    rule: noMultiRootFallthrough,
    files: {
      "src/Panel.vue": multiRoot("", `<button @click="$emit('select')" /><main />`),
      "src/App.vue": caller("Panel", `<Panel class="panel" @select="select" />`),
    },
  });
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.why).toContain("can still invoke");
  expect(result.diagnostics[0]?.suggestion).toContain("declare the event in emits");
  expect(result.diagnostics[0]?.suggestion).not.toMatch(/remove/i);
});

test.each([
  [
    "dynamic target reads $attrs",
    multiRoot("", '<component :is="$attrs" /><span />'),
    'id="root"',
    false,
  ],
  [
    "aliased useAttrs",
    multiRoot(
      "import { useAttrs as readAttrs } from 'vue'\nconst attrs = readAttrs()",
      '<header /><main v-bind="attrs" />',
    ),
    'class="panel"',
    false,
  ],
  [
    "aliased instance reader",
    multiRoot(
      "import { getCurrentInstance as current } from 'vue'\nconst attrs = current()?.attrs",
      '<header /><main v-bind="attrs" />',
    ),
    'class="panel"',
    false,
  ],
  [
    "unrelated helper",
    multiRoot("import { useAttrs } from './helpers'\nuseAttrs()"),
    'class="panel"',
    true,
  ],
  [
    "shadowed helper",
    multiRoot(
      "import { useAttrs } from 'vue'\nfunction setupLocal(useAttrs: () => void) { useAttrs() }\nsetupLocal(() => {})",
    ),
    'class="panel"',
    true,
  ],
  [
    "later static spread",
    multiRoot("defineOptions({ inheritAttrs: true, ...{ inheritAttrs: false } })"),
    'class="panel"',
    false,
  ],
  [
    "later unknown spread",
    multiRoot("import rest from './options'\ndefineOptions({ inheritAttrs: true, ...rest })"),
    'class="panel"',
    false,
  ],
  [
    "later computed key",
    multiRoot("defineOptions({ inheritAttrs: true, ['inheritAttrs']: false })"),
    'class="panel"',
    false,
  ],
  [
    "setup overrides normal options",
    `${multiRoot("defineOptions({ inheritAttrs: true })")}<script lang="ts">export default { inheritAttrs: false }</script>`,
    'class="panel"',
    true,
  ],
  ["empty defineOptions", multiRoot("defineOptions()"), 'class="panel"', true],
  [
    "local mixins",
    multiRoot("defineOptions({ mixins: [{ props: ['title'], emits: ['save'] }] })"),
    'title="x" @save="save"',
    false,
  ],
  [
    "external script",
    `<script src="./options.js"></script><template><header /><main /></template>`,
    'title="x" @save="save"',
    false,
  ],
  [
    "destructured model",
    multiRoot("const [model, modifiers] = defineModel()"),
    'v-model="value"',
    false,
  ],
  [
    "merged interfaces",
    multiRoot(
      "interface Props { first: string }\ninterface Props { second: string }\ndefineProps<Props>()",
    ),
    'first="x"',
    false,
  ],
  [
    "unreadable emits with a handler binding",
    multiRoot("import events from './events'\ndefineEmits(events)"),
    ':onSave="save"',
    false,
  ],
  ["non-breaking space root", multiRoot("", "&nbsp;<main />"), 'class="panel"', true],
] as const)("VUE0051 uses complete evidence: %s", async (_name, component, attrs, reports) => {
  const result = await runRuleFixture({
    rule: noMultiRootFallthrough,
    files: {
      "src/Panel.vue": component,
      "src/App.vue": caller("Panel", `<Panel ${attrs} />`),
    },
  });
  expect(result.diagnostics).toHaveLength(reports ? 1 : 0);
});
