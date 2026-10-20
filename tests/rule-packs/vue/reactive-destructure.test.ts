import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { runVueSfcRuleFixture } from "../../rule-fixtures.ts";
import { noReactiveDestructure } from "../../../src/rule-packs/vue/rules/vue/no-reactive-destructure.ts";
import { noSetupPropsDestructure } from "../../../src/rule-packs/vue/rules/vue/no-setup-props-destructure.ts";

const setup = (body: string, imports = "import { reactive, shallowReactive, toRefs } from 'vue'") =>
  `<script setup lang="ts">\n${imports}\n${body}\n</script>`;

test.each([
  [
    "a reactive binding in script setup",
    "const state = reactive({ count: 0, label: 'a' })\nconst { count } = state",
    "{ count }",
  ],
  [
    "several primitive keys and a renamed binding",
    "const state = reactive({ count: 0, open: false, items: [] })\nconst { count: total, open, items } = state",
    "{ count: total, open, items }",
  ],
  ["reactive() directly", "const { count } = reactive({ count: 0 })", "{ count }"],
  [
    "shallowReactive()",
    "const state = shallowReactive({ page: 1 })\nconst { page } = state",
    "{ page }",
  ],
  [
    "typed reactive() state",
    "const state = reactive<State>({ count: -1, name: `n`, empty: null } as State)\nconst { count, name, empty } = state as State",
    "{ count, name, empty }",
  ],
  [
    "a destructure in a nested block of the same scope",
    "const state = reactive({ count: 0 })\nif (ready) { const { count } = state; use(count) }",
    "{ count }",
  ],
])("reports %s", async (_, body, pattern) => {
  const file = setup(body);
  const result = await runVueSfcRuleFixture(noReactiveDestructure, file);
  expect(result.diagnostics).toHaveLength(1);
  const [diagnostic] = result.diagnostics;
  expect(diagnostic).toMatchObject({ ruleId: noReactiveDestructure.meta.id, code: "VUE0033" });
  expect(file.slice(diagnostic!.range!.start, diagnostic!.range!.end)).toBe(pattern);
});

test("names the keys and points to toRefs for reactive bindings", async () => {
  const result = await runVueSfcRuleFixture(
    noReactiveDestructure,
    setup("const form = reactive({ email: '', valid: false })\nconst { email, valid } = form"),
  );
  expect(result.diagnostics[0]?.why).toContain("email, valid");
  expect(result.diagnostics[0]?.why).toContain("form.email");
  expect(result.diagnostics[0]?.suggestion).toContain("toRefs(form)");
});

test.each([
  ["toRefs()", "const state = reactive({ count: 0 })\nconst { count } = toRefs(state)"],
  [
    "a fresh read in a callback",
    "const state = reactive({ count: 0 })\nfunction log() { const { count } = state; console.log(count) }",
  ],
  [
    "a fresh read in a computed getter",
    "const state = reactive({ count: 0 })\nconst label = computed(() => { const { count } = state; return `${count}` })",
  ],
  [
    "nested objects that stay reactive",
    "const state = reactive({ user: { name: '' }, items: [] })\nconst { user, items } = state",
  ],
  [
    "keys with non-literal initial values",
    "const state = reactive({ count: initial, total: ref(0) })\nconst { count, total } = state",
  ],
  [
    "a reactive() argument Doctor cannot see",
    "const state = reactive(createState())\nconst { count } = state",
  ],
  [
    "a reassignable reactive binding",
    "let state = reactive({ count: 0 })\nconst { count } = state",
  ],
  [
    "reactive() from another library",
    "const { count } = reactive({ count: 0 })",
    "import { reactive } from 'other'",
  ],
  ["a plain object", "const state = { count: 0 }\nconst { count } = state"],
  ["computed keys", "const state = reactive({ [key]: 0 })\nconst { [key]: value } = state"],
])("stays silent for %s", async (_, body, imports?: string) => {
  const result = await runVueSfcRuleFixture(
    noReactiveDestructure,
    setup(body, imports ?? "import { computed, reactive, ref, toRefs } from 'vue'"),
  );
  expect(result.diagnostics).toEqual([]);
});

test("reports composables that return destructured reactive state", async () => {
  const result = await runRuleFixture({
    rule: noReactiveDestructure,
    framework: "vue",
    files: {
      "src/composables/useCounter.ts":
        "import { reactive } from 'vue'\nexport function useCounter() {\n  const state = reactive({ count: 0 })\n  const { count } = state\n  return { count, increment: () => state.count++ }\n}",
    },
  });
  expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
    noReactiveDestructure.meta.id,
  ]);
});

test("leaves setup() props destructuring to no-setup-props-destructure", async () => {
  const file =
    "<script lang=\"ts\">\nimport { defineComponent, reactive } from 'vue'\nexport default defineComponent({ setup(props) { const { count } = props; const state = reactive({ open: false }); return { count, state } } })\n</script>";
  const reactive = await runVueSfcRuleFixture(noReactiveDestructure, file);
  expect(reactive.diagnostics).toEqual([]);
  const props = await runVueSfcRuleFixture(noSetupPropsDestructure, file);
  expect(props.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
    noSetupPropsDestructure.meta.id,
  ]);
});
