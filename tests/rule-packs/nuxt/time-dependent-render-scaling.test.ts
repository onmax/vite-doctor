import { expect, test, vi } from "vite-plus/test";
import { runNuxtAppRuleFixture } from "../../../src/core/testkit.ts";
import { noTimeDependentRenderWithoutNuxtTimeOrClientOnly } from "../../../src/rule-packs/nuxt/rules/nuxt/no-time-dependent-render-without-nuxt-time-or-client-only.ts";

const walked = vi.hoisted(() => ({ nodes: 0 }));

vi.mock("../../../src/core/rule-authoring.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/core/rule-authoring.ts")>();
  return {
    ...original,
    walkScriptLocal: (node: unknown, visit: (node: unknown) => void) =>
      original.walkScriptLocal(node, (current) => {
        walked.nodes++;
        visit(current);
      }),
  };
});

// Every helper writes the shared `last` binding from a nested function and is reached through a
// wrapper, which used to rescan the whole script per candidate, alias write, and call site.
function renderedHelpers(count: number) {
  const script = ["const state = { now: 0 }", "let last"];
  const template: string[] = [];
  for (let index = 0; index < count; index++) {
    script.push(`function helper${index}(x) {
  const stamp = Date.now()
  track(stamp)
  last = stamp
  if (x > ${index}) { state.now = new Date() }
  return String(stamp - x) + Math.random()
}
function wrap${index}() { log(${index}); return helper${index}(${index}) }
const value${index} = wrap${index}()
const click${index} = () => { console.log(new Date()) }`);
    template.push(`<span @click="click${index}">{{ value${index} }}</span>`);
  }
  return `<script setup lang="ts">\n${script.join("\n")}\n</script>\n<template><div>${template.join("")}</div></template>`;
}

async function walkedNodes(count: number) {
  walked.nodes = 0;
  const result = await runNuxtAppRuleFixture(
    noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
    renderedHelpers(count),
  );
  expect(result.diagnostics.length).toBeGreaterThan(0);
  return walked.nodes;
}

test("indexes script walks once per root instead of per time-dependent candidate", async () => {
  const small = await walkedNodes(10);
  const large = await walkedNodes(40);
  // Script size grows 4x; per-root indexes keep the walked nodes roughly proportional to it.
  expect(large / small).toBeLessThan(8);
});
