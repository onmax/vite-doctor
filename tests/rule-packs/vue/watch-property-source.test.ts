import { compileScript, parse } from "@vue/compiler-sfc";
import { expect, test } from "vite-plus/test";
import { runVueSfcRuleFixture } from "../../rule-fixtures.ts";
import { vueRulePack } from "../../../src/rule-packs/vue/index.ts";
import { noPropertyReadWatchSource } from "../../../src/rule-packs/vue/rules/vue/index.ts";

const RULE_ID = "vue/watch/no-property-read-source";

async function run(script: string) {
  const result = await runVueSfcRuleFixture(
    noPropertyReadWatchSource,
    `<script setup lang="ts">
import { reactive, ref, shallowReactive, watch, type Ref } from 'vue'
${script}
</script>`,
  );
  return result.diagnostics;
}

test("VUE0050 is recommended", () => {
  expect(vueRulePack.presets.recommended).toContain(RULE_ID);
});

test.each([
  ["const props = defineProps<{ user: string }>()", "watch(props.user, cb)", ["props.user"]],
  [
    "const props = withDefaults(defineProps<{ id?: string }>(), { id: '' })",
    "watch(props.id, cb)",
    ["props.id"],
  ],
  [
    "const props = defineProps<{ user: { id: number } }>()",
    "watch(props.user.id, cb)",
    ["props.user.id"],
  ],
  ["const props = defineProps({ user: String })", "watch(props['user'], cb)", ["props['user']"]],
  [
    "const state = reactive({ filters: { query: '' }, page: 1 })",
    "watch([state.filters.query, () => state.page], cb)",
    ["state.filters.query"],
  ],
  ["const state = reactive({ page: 1 })", "watch(state.page as number, cb)", ["state.page"]],
])("VUE0050 reports %s with %s", async (declaration, call, sources) => {
  const diagnostics = await run(`${declaration}\n${call}`);
  expect(diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual(sources.map(() => RULE_ID));
  for (const [index, source] of sources.entries())
    expect(diagnostics[index]!.why).toContain(`watch(${source}, ...) reads the property once`);
});

test("VUE0050 suggests a getter that Vue's compiler accepts", async () => {
  const source = `<script setup lang="ts">
import { watch } from 'vue'
const props = defineProps<{ user: string }>()
watch(props.user, cb)
</script>`;
  // Vue's compiler only rejects destructured props passed to watch(), not property reads.
  expect(() => compileScript(parse(source).descriptor, { id: "test" })).not.toThrow();
  const result = await runVueSfcRuleFixture(noPropertyReadWatchSource, source);
  const fix = result.diagnostics[0]!.fix!;
  expect(fix.kind).toBe("suggestion");
  const [edit] = fix.edits;
  const fixed = source.slice(0, edit!.range.start) + edit!.text + source.slice(edit!.range.end);
  expect(fixed).toContain("watch(() => props.user, cb)");
  expect(() => compileScript(parse(fixed).descriptor, { id: "test" })).not.toThrow();
  const rerun = await runVueSfcRuleFixture(noPropertyReadWatchSource, fixed);
  expect(rerun.diagnostics).toEqual([]);
});

test.each([
  ["const props = defineProps<{ source: Ref<number> }>()", "watch(props.source, cb)"],
  ["const props = defineProps(['user'])", "watch(props.user.id, cb)"],
  ["const state = reactive({ getter: () => 1 })", "watch(state.getter, cb)"],
  ["const state = reactive({ get source() { return () => 1 } })", "watch(state.source, cb)"],
  [
    "const state = reactive({ inner: shallowReactive({ source: ref(1) }) })",
    "watch(state.inner.source, cb)",
  ],
  ["const state = reactive({ filters: { query: '' } })", "watch(state.filters, cb)"],
  [
    "const state = reactive({ source: null as null | Ref<number> }); state.source = ref(1)",
    "watch(state.source, cb)",
  ],
  ["const props = defineProps<{ user: User }>()", "watch(() => props.user, cb)"],
  ["const props = defineProps<{ user: User }>()", "watch(props, cb)"],
  ["const state = reactive({ nested: {} })", "watch(state, cb)"],
  ["const state = reactive({ count: 0 })", "watch(() => state.count, cb)"],
  ["const state = reactive({ count: 0 })", "watch(state.count.toFixed(), cb)"],
  ["const list = reactive([ref(1)])", "watch(list[0], cb)"],
  ["const state = shallowReactive({ count: ref(0) })", "watch(state.count, cb)"],
  ["const state = reactive(initial)", "watch(state.count, cb)"],
  ["const props = useProps()", "watch(props.user, cb)"],
  ["let state = reactive({ count: 0 })", "watch(state.count, cb)"],
  ["const props = defineProps<{ user: User }>()", "observe(props.user, cb)"],
  [
    "const props = defineProps<{ user: User }>()",
    "function inner(props: Holder) { watch(props.user, cb) }",
  ],
])("VUE0050 stays quiet for %s with %s", async (declaration, call) => {
  expect(await run(`${declaration}\n${call}`)).toEqual([]);
});

test("VUE0050 stays quiet when watch is not Vue's", async () => {
  const result = await runVueSfcRuleFixture(
    noPropertyReadWatchSource,
    `<script setup lang="ts">
import { watch } from './watch'
const props = defineProps<{ user: User }>()
watch(props.user, cb)
</script>`,
  );
  expect(result.diagnostics).toEqual([]);
});
