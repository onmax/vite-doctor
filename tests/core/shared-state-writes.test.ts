import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { createRule, type DoctorRule } from "../../src/core/index.ts";
import {
  findSharedStateWrites,
  type SharedStateBinding,
  type SharedStateWrite,
} from "../../src/core/internal/shared-state-writes.ts";
import { runRuleFixture } from "../../src/core/testkit.ts";

function captureWrites(binding: SharedStateBinding): {
  rule: DoctorRule;
  writes: () => SharedStateWrite[];
  graphLookups: () => number;
} {
  let captured: SharedStateWrite[] | undefined;
  let graphLookups = 0;
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
          const graph = await ctx.inventory.importGraph();
          const measuredGraph = {
            ...graph,
            importersOf(file: string) {
              graphLookups++;
              return graph.importersOf(file);
            },
            importsOf(file: string) {
              graphLookups++;
              return graph.importsOf(file);
            },
          };
          captured = await findSharedStateWrites(ctx, measuredGraph, {
            ...binding,
            file: join(ctx.project.root, binding.file),
          });
        },
      };
    },
  });
  return {
    rule,
    graphLookups: () => graphLookups,
    writes: () => {
      if (!captured) throw new Error("The capture Rule did not run.");
      return captured;
    },
  };
}

test("cyclic namespaces do not enumerate paths unused by consumers", async () => {
  const capture = captureWrites({ file: "store.ts", exportName: "store", shape: "reactive" });
  const features = Array.from({ length: 8 }, (_, index) => `feature${index}`);
  const files = {
    "store.ts": "export const store = { count: 0 }",
    "index.ts": [
      `export { store } from './store'`,
      ...features.map((name) => `export * as ${name} from './${name}'`),
    ].join("\n"),
    ...Object.fromEntries(
      features.map((name) => [`${name}.ts`, `export * as packageApi from './index'`]),
    ),
    "a.ts": `import { store } from './index'; store.count++`,
    "b.ts": `import { store } from './index'; store.count = 2`,
    "c.ts": `import * as api from './index';
api.feature0.packageApi.feature0.packageApi.store.count--;
api.feature0.packageApi.feature0.store.count++`,
  };
  await runRuleFixture({ rule: capture.rule, files });

  expect(capture.writes().map(({ target }) => target)).toEqual([
    "store.count",
    "store.count",
    "api.feature0.packageApi.feature0.packageApi.store.count",
  ]);
  expect(capture.graphLookups()).toBeLessThanOrEqual(2 * Object.keys(files).length);
});

test("call access finds writes to what importers get from calling the export", async () => {
  const capture = captureWrites({
    file: "src/stores/counter.ts",
    exportName: "useCounter",
    shape: "reactive",
    access: "call",
    collectionAt: (path) => (path.length === 1 && path[0] === "tags" ? "set" : undefined),
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
