import { afterAll, expect, test } from "vite-plus/test";
import { createProjectFixture } from "../../../src/core/testkit.ts";
import { noNonSerializableUseState } from "../../../src/rule-packs/nuxt/rules/nuxt/no-non-serializable-use-state.ts";

const nuxtProject = createProjectFixture({ framework: "nuxt", files: { "app/.gitkeep": "" } });
afterAll(() => nuxtProject.dispose());

const unsafe = [
  "() => ({ get callback() { return () => 1 }, set callback(value) {} })",
  "() => ({ callback: 1, ...{ callback: () => 1 } })",
  "() => new Map([['callback', 1], ['callback', () => 1]])",

  "() => () => 1",
  "() => function named() { return 1 }",
  "() => async () => 1",
  "() => function* values() { yield 1 }",
  "() => ({ callback: () => 1 })",
  "() => ({ nested: [{ callback: () => 1 }] })",
  "() => ({ callback() { return 1 } })",
  "() => [() => 1]",
  "() => [...[() => 1]]",
  "() => ({ ...{ callback: () => 1 } })",
  "() => new Map([['callback', () => 1]])",
  "() => new Set([() => 1])",
  "() => ((() => 1) as unknown)",
  "() => ((() => 1) satisfies Function)",
  "() => flag ? () => 1 : 0",
  "() => { return () => 1 }",
  "function init() { return () => 1 }",
  "() => { if (flag) return () => 1; return 0 }",
  "() => { { return () => 1 } }",
  "() => { try { return () => 1 } catch { return 0 } }",
  "() => { try { throw new Error('stop') } catch { return () => 1 } }",
  "() => { try { if (check()) return 1; return 2 } catch { return () => 1 } }",
  "() => { try { if (flag) return compute(); return 2 } catch { return () => 1 } }",
  "() => { try { if (flag) return { value: compute() }; return 2 } catch { return () => 1 } }",
  "() => { try { return { [compute()]: 1 } } catch { return () => 1 } }",
  "() => { try { return { nested: { value: compute() } } } catch { return () => 1 } }",
  "() => { try { return { get [compute()]() { return 1 } } } catch { return () => 1 } }",
  "() => { try { return { set [compute()](value) {} } } catch { return () => 1 } }",
  "() => { try { return { value: compute(), value: 1 } } catch { return () => 1 } }",
  "() => { try { return { ...{ get value() { throw new Error('stop') } } } } catch { return () => 1 } }",
  "() => { try { if (flag) throw new Error('stop'); return 2 } catch { return () => 1 } }",
  "() => ({ get callback() { return () => 1 } })",
];

const safe = [
  "() => ({ ...(() => 1) })",
  "() => ({ ...new Map([['callback', () => 1]]) })",
  "() => ({ callback: () => 1, callback: 1 })",
  "() => ({ ['callback']: () => 1, callback: 1 })",
  "() => ({ callback: () => 1, ...{ callback: 1 } })",
  "() => ({ get callback() { return () => 1 }, callback: 1 })",
  "() => ({ ...{ get callback() { return () => 1 } }, set callback(value) {} })",
  "() => new Map([['callback', () => 1], ['callback', 1]])",

  "() => 1",
  "function init() { return 1 }",
  '() => "function () {}"',
  `() => "new WebSocket('wss://example.test')"`,
  '() => ({ example: "() => () => 1" })',
  "() => ({ value: /* function () {} */ 1 })",
  "() => [1, 2].map(value => value * 2)",
  "() => { function unused() { return () => 1 } return 1 }",
  "() => { return 1; return () => 1 }",
  "() => { throw new Error('stop'); return () => 1 }",
  "() => false ? () => 1 : 1",
  "() => { if (false) return () => 1; return 1 }",
  "() => { try { return () => 1 } finally { return 1 } }",
  "() => { try { return 1 } catch {} return () => 1 }",
  "() => { try { return 1 } catch { return () => 1 } }",
  "() => { try { return { ['value']: 1 } } catch { return () => 1 } }",
  "() => { try { return { callback() { compute() }, callback: 1 } } catch { return () => 1 } }",
  "() => { try { return { get value() { compute(); return 1 } } } catch { return () => 1 } }",
  "() => { try { return { set value(value) { compute() } } } catch { return () => 1 } }",
  "() => { try { if (flag) return 1; return 2 } catch { return () => 1 } }",
  "() => { try { if (flag) { return 1 } else { return 2 } throw new Error('unreachable') } catch { return () => 1 } }",
  "() => { try { if (false) throw new Error('unreachable'); return 2 } catch { return () => 1 } }",
  "() => { try { { return 1 } throw new Error('unreachable') } catch { return () => 1 } }",
  "() => { try { if (flag) return 1; return 2 } catch {} return () => 1 }",
  "() => { try { return [1, { get value() { throw new Error('stop') } }] } catch {} return () => 1 }",
  "() => ({ get value() { return 1 } })",
  "() => ({ set value(value) {} })",
];

async function diagnose(initializer: string, keyed = true, path = "app/pages/state.vue") {
  return nuxtProject.run({
    rule: noNonSerializableUseState,
    files: {
      [path]: `<script setup lang="ts">const state = useState(${keyed ? "'state', " : ""}${initializer})</script>`,
    },
  });
}

test.each(unsafe)("reports a function inside the returned payload: %s", async (initializer) => {
  const result = await diagnose(initializer);
  expect(result.diagnostics.map((d) => d.ruleId)).toEqual([noNonSerializableUseState.meta.id]);
});

test.each(safe)("accepts a payload without a function value: %s", async (initializer) => {
  expect((await diagnose(initializer)).diagnostics).toEqual([]);
});

test("recognizes the initializer-only useState overload", async () => {
  const result = await diagnose("() => () => 1", false);
  expect(result.diagnostics.map((d) => d.ruleId)).toEqual([noNonSerializableUseState.meta.id]);
});

test("preserves client-only payload evidence", async () => {
  expect(
    (await diagnose("() => () => 1", true, "app/components/State.client.vue")).diagnostics,
  ).toEqual([]);
});
