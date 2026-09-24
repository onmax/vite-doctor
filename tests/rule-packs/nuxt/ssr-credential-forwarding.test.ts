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

test.each([
  "{ query: { locale: useRequestHeaders(['accept-language'])['accept-language'] } }",
  "{ query: { headers: useRequestHeaders(['cookie']) } }",
  "{ headers: useRequestHeaders(['accept-language']) }",
  "{ headers: useRequestHeaders([]) }",
  "{ headers: unrelated }",
  "{ headers: { ...unrelated } }",
  "{ headers: { ...useRequestHeaders(['accept']) } }",
])("unforwarded credentials remain diagnosed for %s", async (options) => {
  const result = await runNuxtAppRuleFixture(
    forwardAuthHeadersSsr,
    `<script setup lang="ts">
const unrelated = useRequestHeaders(['accept-language'])
const user = await $fetch('/api/user', ${options})
</script>`,
  );
  expect(result.diagnostics.map((item) => item.ruleId)).toContain(forwardAuthHeadersSsr.meta.id);
});

test.each([
  "{ headers: useRequestHeaders() }",
  "{ headers: useRequestHeaders(['cookie']) }",
  "{ headers: useRequestHeaders(['authorization']) }",
  "{ headers: { cookie } }",
  "{ headers: { 'cookie': cookie } }",
  "{ headers: { Authorization: token } }",
  "{ headers: { 'Authorization': token } }",
  "{ headers }",
  "{ headers: { ...useRequestHeaders(['cookie']), Accept: 'application/json' } }",
  "{ headers: { ...headers, Accept: 'application/json' } }",
])("credential headers satisfy the rule for %s", async (options) => {
  const result = await runNuxtAppRuleFixture(
    forwardAuthHeadersSsr,
    `<script setup lang="ts">
const cookie = useRequestHeaders(['cookie']).cookie
const token = useRequestHeaders(['authorization']).authorization
const headers = useRequestHeaders(['cookie'])
const user = await $fetch('/api/user', ${options})
</script>`,
  );
  expect(result.diagnostics.some((item) => item.ruleId === forwardAuthHeadersSsr.meta.id)).toBe(
    false,
  );
});

test.each(["let", "var"])("reassigned %s headers do not hide missing credentials", async (kind) => {
  const result = await runNuxtAppRuleFixture(
    forwardAuthHeadersSsr,
    `<script setup lang="ts">
${kind} headers = useRequestHeaders(['cookie'])
headers = { Accept: 'application/json' }
const user = await $fetch('/api/user', { headers })
</script>`,
  );
  expect(result.diagnostics.map((item) => item.ruleId)).toContain(forwardAuthHeadersSsr.meta.id);
});

test("cyclic header spreads do not count as credential evidence", async () => {
  const result = await runNuxtAppRuleFixture(
    forwardAuthHeadersSsr,
    `<script setup lang="ts">
const headers = { ...headers }
const user = await $fetch('/api/user', { headers })
</script>`,
  );
  expect(result.diagnostics.map((item) => item.ruleId)).toContain(forwardAuthHeadersSsr.meta.id);
});
