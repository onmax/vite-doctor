import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { preferAliasOverRelativeParent } from "../../../src/rule-packs/nuxt/rules/nuxt/prefer-alias-over-relative-parent.ts";

function manifest(aliases: Record<string, string>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    generatedAt: new Date(Date.now() + 60_000).toISOString(),
    nuxtVersion: "4.5.2",
    vueVersion: "3.5.0",
    rootDir: "/fixture",
    srcDir: "app",
    appDir: "app",
    buildDir: ".nuxt",
    autoImports: [],
    components: [],
    modules: [],
    layers: [{ root: ".", srcDir: "app", priority: 0 }],
    routeRules: {},
    serverHandlers: [],
    aliases,
    ...extra,
  });
}

test("reports imports that climb two directories and names the alias", async () => {
  const result = await runRuleFixture({
    framework: "nuxt",
    rule: preferAliasOverRelativeParent,
    files: {
      ".nuxt/doctor.manifest.json": manifest({
        "~": "app",
        "#server": "server",
        "#shared": "shared",
        "~~": ".",
      }),
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

test.each(["4.1.0", "4.2.2"])(
  "uses a resolved root alias without #server on Nuxt %s",
  async (version) => {
    const result = await runRuleFixture({
      framework: "nuxt",
      dependencies: { nuxt: version },
      rule: preferAliasOverRelativeParent,
      files: {
        ".nuxt/doctor.manifest.json": manifest(
          { "~": "app", "#shared": "shared", "~~": "." },
          { nuxtVersion: version },
        ),
        "server/api/events/index.get.ts": `import { findEvent } from '../../utils/events'`,
      },
    });
    expect(result.diagnostics.map((diagnostic) => diagnostic.suggestion)).toEqual([
      'Import it as "~~/server/utils/events".',
    ]);
  },
);

test("derives suffixes from resolved nested srcDir and shared directory bases", async () => {
  const result = await runRuleFixture({
    framework: "nuxt",
    rule: preferAliasOverRelativeParent,
    files: {
      "nuxt.config.ts": `export default defineNuxtConfig({ srcDir: 'app/src', dir: { shared: 'shared/domain' } })`,
      ".nuxt/doctor.manifest.json": manifest(
        { "~": "app/src", "#shared": "shared/domain", "~~": "." },
        { srcDir: "app/src", appDir: "app/src" },
      ),
      "app/src/components/deep/Card.ts": `import { format } from '../../utils/format'`,
      "server/api/events/index.get.ts": `import { time } from '../../../shared/domain/utils/time'`,
    },
  });
  expect(
    result.diagnostics
      .map((diagnostic) => diagnostic.suggestion)
      .sort((a, b) => String(a).localeCompare(String(b))),
  ).toEqual(['Import it as "#shared/utils/time".', 'Import it as "~/utils/format".']);
});

test("does not invent a replacement when resolved aliases are unavailable", async () => {
  const result = await runRuleFixture({
    framework: "nuxt",
    rule: preferAliasOverRelativeParent,
    files: {
      "server/api/events/index.get.ts": `import { findEvent } from '../../utils/events'`,
    },
  });
  expect(result.diagnostics.map((diagnostic) => diagnostic.suggestion)).toEqual([
    "Use an alias from this Nuxt project's resolved configuration that points to the same module.",
  ]);
});

test("respects alias overrides instead of assuming directory names", async () => {
  const result = await runRuleFixture({
    framework: "nuxt",
    rule: preferAliasOverRelativeParent,
    files: {
      ".nuxt/doctor.manifest.json": manifest({ "~": "other", "#server": "backend", "~~": "." }),
      "app/components/deep/Card.ts": `import { format } from '../../utils/format'`,
      "server/api/events/index.get.ts": `import { findEvent } from '../../utils/events'`,
    },
  });
  expect(
    result.diagnostics
      .map((diagnostic) => diagnostic.suggestion)
      .sort((a, b) => String(a).localeCompare(String(b))),
  ).toEqual(['Import it as "~~/app/utils/format".', 'Import it as "~~/server/utils/events".']);
});
