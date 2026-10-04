import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { noNonSerializableUseState } from "../../../src/rule-packs/nuxt/rules/nuxt/no-non-serializable-use-state.ts";

for (const value of [
  'new Map([["count", 1]])',
  'new Set(["seen"])',
  'new Date("2026-01-01")',
  'new RegExp("test", "gi")',
]) {
  test.each([`() => ${value}`, `() => ({ value: ${value} })`, `function () { return ${value} }`])(
    "accepts a Nuxt payload-supported builtin: %s",
    async (initializer) => {
      const result = await runRuleFixture({
        rule: noNonSerializableUseState,
        framework: "nuxt",
        files: {
          "app/pages/state.vue": `<script setup>const state = useState('state', ${initializer})</script>`,
        },
      });
      expect(result.diagnostics).toEqual([]);
    },
  );
}

test.each([
  '() => new WebSocket("wss://example.com")',
  '() => ({ socket: new WebSocket("wss://example.com") })',
  '() => new Map([["socket", new WebSocket("wss://example.com")]])',
  "() => function () {}",
])("retains existing unsupported-value diagnostics: %s", async (initializer) => {
  const result = await runRuleFixture({
    rule: noNonSerializableUseState,
    framework: "nuxt",
    files: {
      "app/pages/state.vue": `<script setup>const state = useState('state', ${initializer})</script>`,
    },
  });
  expect(result.diagnostics.map((d) => d.ruleId)).toEqual([noNonSerializableUseState.meta.id]);
});
