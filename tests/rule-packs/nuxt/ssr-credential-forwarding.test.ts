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
  "{ headers: useRequestHeaders(['cookie']), ...requestOptions }",
  "{ headers: useRequestHeaders(['cookie']), headers: unrelated }",
  "{ headers: new Headers({ Accept: 'application/json' }) }",
  "{ headers: unrelated }",
  "{ headers: { ...useRequestHeaders(['cookie']), ...overrides } }",
  "{ headers: { ...useRequestHeaders(['cookie']), ...{ cookie: '' } } }",
  "{ headers: { ...useRequestHeaders(['cookie']), ...{ ...overrides, Accept: 'application/json' } } }",
  "{ headers: new Headers([['Accept', 'application/json']]) }",
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
  "({ headers: useRequestHeaders(['cookie']) } as const)",
  "({ headers: useRequestHeaders(['cookie']) } satisfies Record<string, unknown>)",
  "{ headers: (useRequestHeaders(['cookie']) as Record<string, string>) }",
  "{ headers: new Headers([['cookie', cookie]]) }",
  "{ headers: new Headers([['Authorization', token]] as const) }",
  "{ headers: { ...overrides, ...useRequestHeaders(['cookie']) } }",
  "{ headers: { ...useRequestHeaders(['cookie']), ...{ Accept: 'application/json' } } }",
  "{ headers: { ...useRequestHeaders(), cookie: '' } }",
  "{ ...requestOptions, headers: useRequestHeaders(['cookie']) }",
  "{ headers: new Headers({ cookie }) }",
  "{ headers: new Headers(useRequestHeaders(['cookie'])) }",
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

test.each([
  "await $fetch('/api/user', { headers }); var headers = useRequestHeaders(['cookie'])",
  "await $fetch('/api/user', { headers }); const headers = useRequestHeaders(['cookie'])",
  "const headers = useRequestHeaders(['cookie']); try {} catch (headers) { await $fetch('/api/user', { headers }) }",
  "const headers = useRequestHeaders(['cookie']); try {} catch ({ headers }) { await $fetch('/api/user', { headers }) }",
  "const headers = useRequestHeaders(['cookie']); async function load({ headers }) { await $fetch('/api/user', { headers }) }",
  "const headers = useRequestHeaders(['cookie']); { const { headers } = unrelated; await $fetch('/api/user', { headers }) }",
  "const headers = useRequestHeaders(['cookie']); { await $fetch('/api/user', { headers }); const headers = unrelated }",
  "const headers = useRequestHeaders(['cookie']); for (const headers of unrelated) { await $fetch('/api/user', { headers }) }",
])("unavailable or shadowed initializers do not prove forwarding: %s", async (source) => {
  const result = await runNuxtAppRuleFixture(
    forwardAuthHeadersSsr,
    `<script setup lang="ts">${source}</script>`,
  );
  expect(result.diagnostics.map((item) => item.ruleId)).toContain(forwardAuthHeadersSsr.meta.id);
});

test("header aliases resolve in their declaration scope", async () => {
  const result = await runNuxtAppRuleFixture(
    forwardAuthHeadersSsr,
    `<script setup lang="ts">
const headers = useRequestHeaders(['cookie'])
const forwarded = headers
async function load(headers) {
  return $fetch('/api/user', { headers: forwarded })
}
</script>`,
  );
  expect(result.diagnostics).toEqual([]);
});

test.each([
  "if (condition) var headers = { Accept: 'application/json' }; return $fetch('/api/user', { headers })",
  "return $fetch('/api/user', { headers }); if (condition) { var headers = unrelated }",
  "for (var headers of unrelated) {} return $fetch('/api/user', { headers })",
  "try {} catch { var { headers } = unrelated } return $fetch('/api/user', { headers })",
])("nested var bindings shadow outer credentials: %s", async (body) => {
  const result = await runNuxtAppRuleFixture(
    forwardAuthHeadersSsr,
    `<script setup lang="ts">const headers = useRequestHeaders(['cookie']); function load() { ${body} }</script>`,
  );
  expect(result.diagnostics.map((item) => item.ruleId)).toContain(forwardAuthHeadersSsr.meta.id);
});

test("nested functions do not shadow credentials in their parent", async () => {
  const result = await runNuxtAppRuleFixture(
    forwardAuthHeadersSsr,
    `<script setup lang="ts">const headers = useRequestHeaders(['cookie']); function load() { function inner() { var headers = unrelated } return $fetch('/api/user', { headers }) }</script>`,
  );
  expect(result.diagnostics).toEqual([]);
});

test.each([
  ["", "{ headers: new Headers([['cookie', '']]) }", true],
  ["", "{ headers: new Headers([['Authorization', '' as string]]) }", true],
  ["", "{ headers: useRequestHeaders(['cookie']), ...{ method: 'GET' } }", false],
  [
    "const options = { ...{ method: 'GET' } } as const",
    "{ headers: useRequestHeaders(['cookie']), ...options }",
    false,
  ],
  ["", "{ headers: useRequestHeaders(['cookie']), ...{ headers: {} } }", true],
  ["", "{ headers: useRequestHeaders(['cookie']), ...{ [key]: {} } }", true],
  [
    "const options = { ...options }",
    "{ headers: useRequestHeaders(['cookie']), ...options }",
    true,
  ],
  [
    "const names = ['cookie'] as const; const selected = names",
    "{ headers: useRequestHeaders(selected) }",
    false,
  ],
  ["const names = ['accept']", "{ headers: useRequestHeaders(names) }", true],
  ["let names = ['cookie']; names = []", "{ headers: useRequestHeaders(names) }", true],
  ["const names = names", "{ headers: useRequestHeaders(names) }", true],
  ["", "{ headers: useRequestHeaders(unknownNames) }", true],
])("credential evidence with %s and %s", async (setup, options, diagnosed) => {
  const result = await runNuxtAppRuleFixture(
    forwardAuthHeadersSsr,
    `<script setup lang="ts">${setup}; await $fetch('/api/user', ${options})</script>`,
  );
  expect(result.diagnostics.some((item) => item.ruleId === forwardAuthHeadersSsr.meta.id)).toBe(
    diagnosed,
  );
});

test.each([
  "options.headers = {}",
  "delete options.headers",
  "const alias = options; alias.headers = {}",
  "const alias = options.headers; delete alias.cookie",
  "const alias = { ...options }; alias.headers.cookie = ''",
  "Object.assign(options, { headers: {} })",
  "mutate(options)",
])("mutated or escaped options do not prove credentials: %s", async (mutation) => {
  for (const options of ["options", "{ ...options }"]) {
    const result = await runNuxtAppRuleFixture(
      forwardAuthHeadersSsr,
      `<script setup lang="ts">const options = { headers: useRequestHeaders(['cookie']) }; ${mutation}; await $fetch('/api/user', ${options})</script>`,
    );
    expect(result.diagnostics.map((item) => item.ruleId)).toContain(forwardAuthHeadersSsr.meta.id);
  }
});

test.each([
  ["const options = { headers: useRequestHeaders(['cookie']) }", "options", false],
  ["const options = { headers: useRequestHeaders(['cookie']) }", "{ ...options }", false],
  ["", "{ headers: [['cookie', cookie]] }", false],
  ["const headers = [['Authorization', token]] as const", "{ headers }", false],
  ["const headers = [['cookie', cookie]]", "{ headers: new Headers(headers) }", false],
  ["", "{ headers: [['cookie', '']] }", true],
  ["", "{ headers: { cookie: undefined } }", true],
  ["", "{ headers: { Authorization: void 0 } }", true],
  ["", "{ headers: [['cookie', undefined]] }", true],
  ["", "{ headers: new Headers([['cookie', void 0]]) }", true],
])("review credential regression with %s and %s", async (setup, options, diagnosed) => {
  const result = await runNuxtAppRuleFixture(
    forwardAuthHeadersSsr,
    `<script setup lang="ts">${setup}; await $fetch('/api/user', ${options})</script>`,
  );
  expect(result.diagnostics.some((item) => item.ruleId === forwardAuthHeadersSsr.meta.id)).toBe(
    diagnosed,
  );
});

test.each([
  "case 1: const headers = { Accept: 'application/json' }; await $fetch('/api/user', { headers }); break",
  "case 1: await $fetch('/api/user', { headers }); break; case 2: const headers = {}",
])("switch lexical bindings shadow outer headers: %s", async (cases) => {
  const result = await runNuxtAppRuleFixture(
    forwardAuthHeadersSsr,
    `<script setup lang="ts">const headers = useRequestHeaders(['cookie']); switch (value) { ${cases} }</script>`,
  );
  expect(result.diagnostics.map((item) => item.ruleId)).toContain(forwardAuthHeadersSsr.meta.id);
});
