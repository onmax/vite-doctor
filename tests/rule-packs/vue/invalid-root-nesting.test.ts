import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { vueRulePack } from "../../../src/rule-packs/vue/index.ts";
import { noInvalidRootNesting } from "../../../src/rule-packs/vue/rules/vue/index.ts";
import { parserMovesChild } from "../../../src/rule-packs/vue/rules/vue/html-nesting.ts";

const ssrRenderer = { "@vue/server-renderer": "^3.5.0" };

const component = (template: string) => `<template>
  ${template}
</template>`;

const caller = (imports: string[], template: string, dir = ".") => `<script setup lang="ts">
${imports.map((name) => `import ${name} from '${dir}/${name}.vue'`).join("\n")}
</script>
<template>
  ${template}
</template>`;

function located(result: Awaited<ReturnType<typeof runRuleFixture>>) {
  return result.diagnostics
    .map((diagnostic) => [
      diagnostic.code,
      diagnostic.file.slice(result.root.length + 1),
      diagnostic.range?.line,
    ])
    .sort((a, b) => `${a[1]}:${a[2]}`.localeCompare(`${b[1]}:${b[2]}`));
}

test("VUE0052 is in the recommended preset", () => {
  expect(vueRulePack.presets.recommended).toContain(noInvalidRootNesting.meta.id);
});

test("VUE0052 reports a component whose root the HTML parser moves out of the usage's parent", async () => {
  const result = await runRuleFixture({
    rule: noInvalidRootNesting,
    dependencies: ssrRenderer,
    files: {
      "src/Card.vue": component("<div><slot /></div>"),
      "src/Row.vue": component("<tr><td>cell</td></tr>"),
      "src/ProfileLink.vue": component('<a href="/me">Me</a>'),
      "src/Search.vue": component("<form><input /></form>"),
      "src/Status.vue": component(
        '<div v-if="error">Failed</div>\n  <section v-else>Done</section>',
      ),
      "src/Header.vue": component("<!-- title -->\n  <h1>Title</h1>\n  <div>Subtitle</div>"),
      "src/Page.vue": caller(
        ["Card", "Row", "ProfileLink", "Search", "Status", "Header"],
        `<p><Card /></p>
  <table><Row /></table>
  <a href="/"><ProfileLink /></a>
  <form><Search /></form>
  <p><template v-if="ok"><Status /></template></p>
  <h2><Header /></h2>`,
      ),
    },
  });

  expect(located(result)).toEqual([
    ["VUE0052", "src/Page.vue", 10],
    ["VUE0052", "src/Page.vue", 11],
    ["VUE0052", "src/Page.vue", 12],
    ["VUE0052", "src/Page.vue", 13],
    ["VUE0052", "src/Page.vue", 14],
    ["VUE0052", "src/Page.vue", 15],
  ]);
  const card = result.diagnostics.find((diagnostic) => diagnostic.range?.line === 10)!;
  expect(card.why).toContain("<p>");
  expect(card.why).toContain("<div>");
  expect(card.why).toContain("it depends on @vue/server-renderer");
  expect(card.related?.[0]?.file).toBe(join(result.root, "src/Card.vue"));
});

test("VUE0052 reports in a Nuxt app that renders on the server", async () => {
  const files = {
    "app/components/Card.vue": component("<div><slot /></div>"),
    "app/pages/index.vue": caller(["Card"], "<p><Card /></p>", "../components"),
  };
  const ssr = await runRuleFixture({ rule: noInvalidRootNesting, framework: "nuxt", files });
  const spa = await runRuleFixture({
    rule: noInvalidRootNesting,
    framework: "nuxt",
    files: { ...files, "nuxt.config.ts": "export default defineNuxtConfig({ ssr: false })" },
  });
  const spaRoute = await runRuleFixture({
    rule: noInvalidRootNesting,
    framework: "nuxt",
    files: {
      ...files,
      "nuxt.config.ts":
        "export default defineNuxtConfig({ routeRules: { '/admin/**': { ssr: false } } })",
    },
  });

  expect(located(ssr)).toEqual([["VUE0052", "app/pages/index.vue", 5]]);
  expect(spa.diagnostics).toEqual([]);
  expect(spaRoute.diagnostics).toEqual([]);
});

test("VUE0052 stays quiet when the parser keeps the root where Vue rendered it", async () => {
  const result = await runRuleFixture({
    rule: noInvalidRootNesting,
    dependencies: ssrRenderer,
    files: {
      "src/Card.vue": component("<div><slot /></div>"),
      "src/Badge.vue": component("<span><slot /></span>"),
      "src/Row.vue": component("<tr><td>cell</td></tr>"),
      "src/Mixed.vue": component('<div v-if="block">A</div>\n  <span v-else>B</span>'),
      "src/Term.vue": component("<dd>term</dd>"),
      "src/Choice.vue": component("<div>option</div>"),
      "src/Page.vue": caller(
        ["Card", "Badge", "Row", "Mixed", "Term", "Choice"],
        `<div><Card /></div>
  <p><Badge /></p>
  <table><tbody><Row /></tbody></table>
  <p><Mixed /></p>
  <section><Term /></section>
  <select><Choice /></select>`,
      ),
    },
  });

  expect(result.diagnostics).toEqual([]);
});

test("VUE0052 stays quiet when Doctor cannot prove the rendered parent, root, or server render", async () => {
  const files = {
    "src/Card.vue": component("<div><slot /></div>"),
    "src/Wrapper.vue": component("<Card><slot /></Card>"),
    "src/Outlet.vue": component("<slot />"),
    "src/List.vue": component('<div v-for="item in 3" :key="item">{{ item }}</div>'),
    "src/Inline.client.vue": component("<div>client</div>"),
    "src/Page.vue": caller(
      ["Card", "Wrapper", "Outlet", "List"],
      `<Panel><Card /></Panel>
  <p><Wrapper /></p>
  <p><Outlet /></p>
  <p><List /></p>
  <ClientOnly><p><Card /></p></ClientOnly>
  <p><slot><Card /></slot></p>
  <p><Unresolved /></p>
  <p><component :is="Card" /></p>`,
    ),
    "src/Client.vue": `<script setup lang="ts">
import Inline from './Inline.client.vue'
</script>
<template>
  <p><Inline /></p>
</template>`,
    "src/Island.client.vue": caller(["Card"], "<p><Card /></p>"),
  };
  const ssr = await runRuleFixture({
    rule: noInvalidRootNesting,
    dependencies: ssrRenderer,
    files,
  });
  const spa = await runRuleFixture({
    rule: noInvalidRootNesting,
    files: { ...files, "src/Spa.vue": caller(["Card"], "<p><Card /></p>") },
  });

  expect(ssr.diagnostics).toEqual([]);
  expect(spa.diagnostics).toEqual([]);
});

test("parserMovesChild keeps only Vue's nesting errors that the HTML parser rewrites", () => {
  const moved = [
    ["p", "div"],
    ["p", "table"],
    ["p", "dd"],
    ["table", "tr"],
    ["tbody", "td"],
    ["tr", "div"],
    ["a", "a"],
    ["button", "button"],
    ["form", "form"],
    ["li", "li"],
    ["h2", "h1"],
    ["div", "td"],
    ["svg", "div"],
  ];
  const kept = [
    ["div", "div"],
    ["p", "span"],
    ["section", "dd"],
    ["span", "figcaption"],
    ["div", "area"],
    ["select", "div"],
    ["option", "span"],
    ["table", "template"],
    ["tr", "input"],
  ];
  expect(moved.filter(([parent, child]) => !parserMovesChild(parent!, child!))).toEqual([]);
  expect(kept.filter(([parent, child]) => parserMovesChild(parent!, child!))).toEqual([]);
});
