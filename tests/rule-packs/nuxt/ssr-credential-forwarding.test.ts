import { expect, test } from "vite-plus/test";
import { runNuxtAppRuleFixture } from "../../../src/core/testkit.ts";
import { forwardAuthHeadersSsr } from "../../../src/rule-packs/nuxt/rules/nuxt/forward-auth-headers-ssr.ts";

test("unrelated headers do not hide missing SSR credentials", async () => {
  const result = await runNuxtAppRuleFixture(
    forwardAuthHeadersSsr,
    `<script setup lang="ts">
const user = await $fetch('/api/user', { headers: { Accept: 'application/json' } })
</script>`,
  );
  expect(result.diagnostics.map((item) => item.ruleId)).toContain(forwardAuthHeadersSsr.meta.id);
});

test("request headers passed through a variable satisfy the rule", async () => {
  const result = await runNuxtAppRuleFixture(
    forwardAuthHeadersSsr,
    `<script setup lang="ts">
const forwarded = useRequestHeaders(['cookie'])
const user = await $fetch('/api/user', { headers: forwarded })
</script>`,
  );
  expect(result.diagnostics.some((item) => item.ruleId === forwardAuthHeadersSsr.meta.id)).toBe(
    false,
  );
});
