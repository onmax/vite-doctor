import { afterAll, expect, test } from "vite-plus/test";
import { createProjectFixture } from "../../../src/core/testkit.ts";
import nuxtRulePack, {
  requireClientOnlyFallback,
} from "../../../src/rule-packs/nuxt/rules/nuxt/index.ts";
import { getRuleDocuments, rulesCollectionSource } from "../../../docs/rules/source.ts";

const ruleId = "nuxt/hydration/require-clientonly-fallback";
const project = createProjectFixture({ framework: "nuxt", files: { "app/.gitkeep": "" } });
afterAll(() => project.dispose());

async function reported(template: string, file = "app/components/Panel.vue") {
  const result = await project.run({
    rule: requireClientOnlyFallback,
    files: { [file]: `<template>\n${template}\n</template>\n` },
  });
  return result.diagnostics;
}

test("is a Strict-only rule documented with a strict run command", async () => {
  expect(nuxtRulePack.presets.recommended).not.toContain(ruleId);
  expect(nuxtRulePack.presets.strict).toContain(ruleId);
  const document = getRuleDocuments().find((rule) => rule.id === ruleId)!;
  expect(document.diagnosticCodes).toEqual(["NUXT0086"]);
  expect(await rulesCollectionSource.getItem(document.key)).toContain(
    `pnpm nuxt doctor --extends auto,nuxt/strict --rules ${ruleId}`,
  );
});

test.each([
  ["<ClientOnly>\n  <AgGridVue :rows='rows' />\n</ClientOnly>"],
  ["<client-only><FullCalendar :options='options' /></client-only>"],
  ["<ClientOnly class='h-80'>\n  <Chart />\n</ClientOnly>"],
  ["<ClientOnly><h3>Forecast</h3><ForecastChart /></ClientOnly>"],
  ["<ClientOnly><Modal v-if='open' /><Chart /></ClientOnly>"],
  ["<ClientOnly fallback><Chart /></ClientOnly>"],
  ["<ClientOnly #fallback><Chart /><template #fallback /></ClientOnly>"],
  ["<ClientOnly v-slot:fallback><Chart /><template v-slot:fallback /></ClientOnly>"],
  ["<ClientOnly placeholder=''><Chart /></ClientOnly>"],
  ["<ClientOnly><template v-if='ready'><Chart /></template></ClientOnly>"],
  ["<ClientOnly><Chart /><template #fallback /></ClientOnly>"],
  ["<ClientOnly><Chart /><template #placeholder>\n  <!-- todo -->\n</template></ClientOnly>"],
])("reports ClientOnly without a fallback: %s", async (template) => {
  const diagnostics = await reported(template);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ ruleId, code: "NUXT0086", severity: "info" });
  expect(diagnostics[0]!.suggestion).toContain("#fallback");
});

test.each([
  ["<ClientOnly><Chart /><template #fallback><USkeleton class='h-80' /></template></ClientOnly>"],
  ["<ClientOnly><Chart /><template v-slot:placeholder>Loading</template></ClientOnly>"],
  ["<ClientOnly fallback='Loading chart'><Chart /></ClientOnly>"],
  ["<ClientOnly :placeholder='label'><Chart /></ClientOnly>"],
  ["<ClientOnly fallback-tag='div' class='h-80'><Chart /></ClientOnly>"],
  ["<ClientOnly placeholderTag='section'><Chart /></ClientOnly>"],
  ["<ClientOnly v-bind='fallbackProps'><Chart /></ClientOnly>"],
  ["<ClientOnly v-slot:fallback><USkeleton class='h-80' /></ClientOnly>"],
  ["<ClientOnly #placeholder>Loading</ClientOnly>"],
  ["<ClientOnly v-bind:[propName]='label'><Chart /></ClientOnly>"],
  ["<ClientOnly><Chart /><template v-slot:[slotName]>Loading</template></ClientOnly>"],
  ["<ClientOnly />"],
  ["<ClientOnly>\n  <!-- nothing yet -->\n</ClientOnly>"],
  ["<ClientOnly>\n  <!-- modal -->\n  <NPIFormDistributorModal v-if='open' />\n</ClientOnly>"],
  ["<ClientOnly><Teleport to='body'><Menu /></Teleport></ClientOnly>"],
  ["<ClientOnly><UNotifications /><app-toaster /></ClientOnly>"],
  [
    "<ClientOnly><template v-if='open'><Teleport to='body'><Menu /></Teleport></template></ClientOnly>",
  ],
])("accepts ClientOnly with a fallback or only overlays: %s", async (template) => {
  expect(await reported(template)).toEqual([]);
});

test("ignores .client components", async () => {
  expect(
    await reported("<ClientOnly><Chart /></ClientOnly>", "app/components/Chart.client.vue"),
  ).toEqual([]);
});
