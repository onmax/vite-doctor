import { expect, test } from "vite-plus/test";
import { runVueSfcRuleFixture } from "../../rule-fixtures.ts";
import { noOnWatcherCleanupAfterAwait } from "../../../src/rule-packs/vue/rules/vue/no-on-watcher-cleanup-after-await.ts";

test.each([
  `const load = async () => { await Promise.resolve() }`,
  `async function load() { await Promise.resolve() }; load()`,
])("ignores suspension inside nested async functions: %s", async (declaration) => {
  const result = await runVueSfcRuleFixture(
    noOnWatcherCleanupAfterAwait,
    `<script setup>
watchEffect(() => {
  ${declaration}
  onWatcherCleanup(() => {})
})
</script>`,
  );

  expect(result.diagnostics).toHaveLength(0);
});

test("reports cleanup after awaiting a nested async function", async () => {
  const result = await runVueSfcRuleFixture(
    noOnWatcherCleanupAfterAwait,
    `<script setup>
watchEffect(async () => {
  async function load() { await Promise.resolve() }
  await load()
  onWatcherCleanup(() => {})
})
</script>`,
  );

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.range?.line).toBe(5);
});
