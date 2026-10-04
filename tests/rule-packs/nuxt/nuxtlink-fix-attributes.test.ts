import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { preferNuxtLink } from "../../../src/rule-packs/nuxt/rules/nuxt/prefer-nuxt-link.ts";

test.each([
  [`title="Docs href='legacy'"`, `href="/about"`],
  [`title='Docs href="legacy"'`, `href="/about"`],
  [`data-example=" href = legacy"`, `href = "/about"`],
  [`aria-label="The href='legacy' attribute"`, `href='/about'`],
  [`:title="' href=legacy'"`, `href="/about"`],
  [`title="href=legacy" class="nav"`, `href="/about"`],
  [`class="nav"`, `href="/about"`],
  [`title="Docs"`, `href = '/about'`],
])("NuxtLink fix preserves preceding attribute %s", async (preceding, href) => {
  const source = `<template><a ${preceding} ${href}>About</a></template>`;
  const result = await runRuleFixture({
    rule: preferNuxtLink,
    framework: "nuxt",
    files: { "app/pages/index.vue": source },
  });
  expect(result.diagnostics).toHaveLength(1);
  const fix = result.diagnostics[0]?.fix;
  expect(fix?.kind).toBe("safe");
  expect(fix?.edits).toHaveLength(1);
  const edit = fix!.edits[0]!;
  const fixed = source.slice(0, edit.range.start) + edit.text + source.slice(edit.range.end);
  expect(fixed).toBe(
    `<template><NuxtLink ${preceding} ${href.replace(/^href/, "to")}>About</NuxtLink></template>`,
  );
});
