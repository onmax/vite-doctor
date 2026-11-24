import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { createRule, type DoctorRule } from "../../src/core/index.ts";
import {
  findSharedStateWrites,
  type SharedStateBinding,
  type SharedStateWrite,
} from "../../src/core/internal/shared-state-writes.ts";
import { runRuleFixture } from "../../src/core/testkit.ts";

function captureWrites(binding: Omit<SharedStateBinding, "file"> & { file: string }): {
  rule: DoctorRule;
  writes: () => SharedStateWrite[];
} {
  let captured: SharedStateWrite[] | undefined;
  const rule = createRule({
    meta: {
      id: "test/shared-state-writes",
      title: "Capture shared state writes",
      category: "state",
      severity: "info",
      execution: "workspace",
      cacheScope: "none",
    },
    create(ctx) {
      return {
        async onWorkspaceEnd() {
          captured = await findSharedStateWrites(ctx, await ctx.inventory.importGraph(), {
            ...binding,
            file: join(ctx.project.root, binding.file),
          });
        },
      };
    },
  });
  return {
    rule,
    writes: () => {
      if (!captured) throw new Error("The capture Rule did not run.");
      return captured;
    },
  };
}

test("call access finds writes to what importers get from calling the export", async () => {
  const capture = captureWrites({
    file: "src/stores/counter.ts",
    exportName: "useCounter",
    shape: "reactive",
    access: "call",
  });
  const result = await runRuleFixture({
    rule: capture.rule,
    files: {
      "src/stores/counter.ts": `export const useCounter = defineStore('counter', { state: () => ({ count: 0, tags: new Set<string>() }) })`,
      "src/components/A.vue": `<script setup lang="ts">
import { useCounter } from '../stores/counter'
const counter = useCounter()
counter.count++
counter.tags.add('a')
counter.$patch({ count: 1 })
useCounter().count = 2
</script>
<template><input v-model="counter.count"><p>{{ counter.count }}</p></template>`,
    },
  });

  expect(result.diagnostics).toEqual([]);
  expect(
    capture
      .writes()
      .map((write) => [
        write.file.slice(result.root.length + 1),
        write.range.line,
        write.kind,
        write.in,
        write.target,
      ]),
  ).toEqual([
    ["src/components/A.vue", 4, "update", "script", "counter.count"],
    ["src/components/A.vue", 5, "mutating-call", "script", "counter.tags"],
    ["src/components/A.vue", 7, "assignment", "script", "useCounter().count"],
    ["src/components/A.vue", 9, "v-model", "template", "counter.count"],
  ]);
});
