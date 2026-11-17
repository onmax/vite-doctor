import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { expect, test, vi } from "vite-plus/test";
import type { DoctorRule, RuleVisitor } from "../../src/core/primitives.ts";
import { runViteDoctor, viteDoctorRulePacks } from "../../src/doctor.ts";

const checked = vi.hoisted(() => new Set<string>());

vi.mock("../../src/core/internal/rule-hooks.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/core/internal/rule-hooks.ts")>();
  return {
    ...original,
    assertKnownRuleHooks(rule: DoctorRule, visitor: RuleVisitor) {
      original.assertKnownRuleHooks(rule, visitor);
      checked.add(rule.meta.id);
    },
  };
});

const files: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "fixture",
    type: "module",
    dependencies: { nuxt: "^4.0.0", vue: "^3.5.0", pinia: "^3.0.0" },
  }),
  "nuxt.config.ts": "export default defineNuxtConfig({ ssr: true });\n",
  "app/app.vue": `<script setup lang="ts">
const props = defineProps<{ title: string }>();
const items = ref([{ id: 1 }]);
const { data } = await useFetch("/api/items");
</script>
<template>
  <div :class="props.title"><span v-for="item in items" :key="item.id">{{ item.id }}</span></div>
</template>
`,
  "app/composables/useCounter.ts": "export function useCounter() { return ref(0); }\n",
  "app/stores/counter.ts":
    'export const useCounterStore = defineStore("counter", { state: () => ({ n: 0 }) });\n',
  "server/api/items.ts":
    "export default defineEventHandler(async (event) => { const body = await readBody(event); return [body]; });\n",
  "src/util.ts":
    "export async function load(url: string): Promise<unknown> { try { return await fetch(url); } catch (error) { console.error(error); return undefined as any; } }\n",
};

test("no built-in Rule returns a hook Doctor does not call", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-builtin-hooks-"));
  try {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    const packs = await viteDoctorRulePacks({ root });
    await runViteDoctor({
      root,
      cache: false,
      extends: packs.map(
        (pack) => `${pack.name}/${pack.presets.strict ? "strict" : "recommended"}`,
      ),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  expect(checked.size).toBeGreaterThan(100);
});
