import { expect, test } from "vite-plus/test";
import { runRuleFixture, runVueSfcRuleFixture } from "../../../src/core/testkit.ts";
import { noSetupPropsDestructure } from "../../../src/rule-packs/vue/rules/vue/no-setup-props-destructure.ts";

test.each([
  "import * as Vue from 'vue'; export default Vue.defineComponent({ setup(props) { const { count } = props; return { count } } })",
  "const component = { setup(props) { const { count } = props; return { count } } }; export default component",
  "export default { setup(input) { const { count } = input; return { count } } }",
  "export default { setup(props) { const { count } = props; return { count } } }",
  "export default { setup: (input) => { const { count } = input; return { count } } }",
  "export default { setup: function (input) { const { count } = input; return { count } } }",
  "export default { setup(input = {}) { const { count } = input; return { count } } }",
  "export default { setup({ count }) { return { count } } }",
  "export default { setup(input) { if (enabled) { const { count } = input; use(count) } } }",
  "import { defineComponent } from 'vue'; export default defineComponent({ setup(input) { const { count } = input; return { count } } })",
  "import { defineComponent as component } from 'vue'; export default component({ setup(input) { const { count } = input; return { count } } })",
  "import { defineComponent } from 'vue'; export default defineComponent(input => { const { count } = input; return () => count })",
  "export default ({ setup(props) { const { count } = props } } satisfies ComponentOptions)",
  "export default ({ setup(props) { const { count } = props } } as ComponentOptions)",
  "export default { setup: ((props: Props) => { const { count } = props }) satisfies SetupFunction }",
  "export default { setup: ((props: Props) => { const { count } = props }) as SetupFunction }",
])("tracks the actual setup prop parameter: %s", async (script) => {
  const result = await runVueSfcRuleFixture(
    noSetupPropsDestructure,
    `<script lang="ts">${script}</script>`,
  );
  expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
    noSetupPropsDestructure.meta.id,
  ]);
});

test.each([
  "export default { setup(props) { const { count } = toRefs(props); return { count } } }",
  "export default { setup(input) { return () => input.count } }",
  "export default { setup(props) { return () => { const { count } = props; return count } } }",
  "export default { setup(props) { watchEffect(() => { const { count } = props; console.log(count) }) } }",
  "export default { setup(props) { { const props = plain(); const { count } = props } } }",
  "export default { setup(props) { function handler(props) { const { count } = props } } }",
  "export default { setup(props) { return {} } }; function unrelated(props) { const { count } = props }",
  "const utilities = { setup(props) { const { count } = props; return count } }; export default {}",
  "// setup(props) is not a component\nconst props = plain(); const { count } = props; export default {}",
  "import { defineComponent } from 'other'; export default defineComponent({ setup(props) { const { count } = props } })",
])(
  "does not mistake other values or reactive callbacks for setup snapshots: %s",
  async (script) => {
    const result = await runVueSfcRuleFixture(
      noSetupPropsDestructure,
      `<script lang="ts">${script}</script>`,
    );
    expect(result.diagnostics).toEqual([]);
  },
);

test("retains TypeScript component diagnostics outside an SFC", async () => {
  const result = await runRuleFixture({
    rule: noSetupPropsDestructure,
    framework: "vue",
    files: {
      "src/component.ts":
        "import { defineComponent } from 'vue'; export default defineComponent({ setup(input: { count: number }) { const { count } = input; return { count } } })",
    },
  });
  expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
    noSetupPropsDestructure.meta.id,
  ]);
});

test("allows compiler-managed reactive props destructuring in script setup", async () => {
  const result = await runVueSfcRuleFixture(
    noSetupPropsDestructure,
    '<script setup lang="ts">const { count } = defineProps<{ count: number }>()</script>',
  );
  expect(result.diagnostics).toEqual([]);
});
