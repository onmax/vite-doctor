import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { preferAliasOverRelativeParent } from "../../../src/rule-packs/nuxt/rules/nuxt/prefer-alias-over-relative-parent.ts";

test("reports imports that climb two directories and names the alias", async () => {
  const result = await runRuleFixture({
    framework: "nuxt",
    rule: preferAliasOverRelativeParent,
    files: {
      "server/api/events/index.get.ts": `import { toVenueTime } from "../../../shared/utils/time"
import { findEvent } from "../../utils/events"
export default defineEventHandler(() => [toVenueTime, findEvent])`,
      "app/components/deep/Card.vue": `<script setup lang="ts">
import { format } from "../../utils/format"
</script>
<template><p>{{ format }}</p></template>`,
    },
  });

  expect(
    result.diagnostics
      .map((diagnostic) => diagnostic.suggestion)
      .sort((a, b) => String(a).localeCompare(String(b))),
  ).toEqual([
    'Import it as "#server/utils/events".',
    'Import it as "#shared/utils/time".',
    'Import it as "~/utils/format".',
  ]);
});

test("allows one level up and aliases", async () => {
  const result = await runRuleFixture({
    framework: "nuxt",
    rule: preferAliasOverRelativeParent,
    files: {
      "server/api/events.get.ts": `import { findEvent } from "../utils/events"
import { schema } from "#shared/schema"
export default defineEventHandler(() => [findEvent, schema])`,
    },
  });

  expect(result.diagnostics).toHaveLength(0);
});
