import { expect, test } from "vite-plus/test";
import { preferSeoComposables } from "../../../src/rule-packs/nuxt/rules/nuxt.ts";
import { runRuleFixture } from "../../../src/core/testkit.ts";

async function count(head: string) {
  const result = await runRuleFixture({
    rule: preferSeoComposables,
    framework: "nuxt",
    files: { "app/app.vue": `<script setup lang="ts">\nuseHead(${head})\n</script>` },
  });
  return result.diagnostics.length;
}

test.each([
  [
    "head that needs useHead next to a title template (vitehub DocsAppShell.vue:24)",
    `{
  titleTemplate: title => title ? \`\${title} · Site\` : 'Site',
  link: site.url ? [{ rel: 'canonical', href: canonical }] : [],
  meta: ownsApp ? [] : [{ name: 'viewport', content: 'width=device-width' }],
  htmlAttrs: ownsApp ? {} : { class: 'docs' },
}`,
  ],
  ["a title template alone", `{ titleTemplate: '%s · Site' }`],
  ["a title next to a link", `{ title: 'Home', link: [{ rel: 'icon', href: '/favicon.ico' }] }`],
  [
    "a title next to non-SEO meta",
    `{ title: 'Home', meta: [{ name: 'viewport', content: 'width=device-width' }] }`,
  ],
  ["meta built elsewhere", `{ meta: headMeta }`],
  ["meta names useSeoMeta does not own", `{ meta: [{ name: 'keywords', content: 'nuxt' }] }`],
])("does not report %s", async (_name, head) => {
  expect(await count(head)).toBe(0);
});

test.each([
  ["a title alone", `{ title: 'Home' }`],
  [
    "a description next to a link",
    `{ meta: [{ name: 'description', content: 'Docs' }], link: [{ rel: 'canonical', href: '/' }] }`,
  ],
  [
    "Open Graph meta in a conditional",
    `{ meta: shared ? [] : [{ property: 'og:title', content: 'Docs' }] }`,
  ],
  ["Twitter meta", `{ meta: [{ name: 'twitter:card', content: 'summary' }] }`],
])("reports %s", async (_name, head) => {
  expect(await count(head)).toBe(1);
});
