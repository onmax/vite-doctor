import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { restrictVHtml } from "../../../src/rule-packs/vue/rules/vue/restrict-v-html.ts";

async function vHtml(files: Record<string, string>, framework: "vue" | "nuxt" = "vue") {
  const result = await runRuleFixture({ rule: restrictVHtml, framework, files });
  return result.diagnostics.map((diagnostic) => ({
    line: diagnostic.range?.line,
    severity: diagnostic.severity,
    confidence: diagnostic.confidence,
    why: diagnostic.why,
  }));
}

test("reports route, storage, fetch and form input as errors", async () => {
  const diagnostics = await vHtml({
    "src/Profile.vue": `<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { useRoute } from "vue-router"
const route = useRoute()
const bio = computed(() => String(route.query.bio ?? ""))
const saved = ref("")
onMounted(() => {
  saved.value = localStorage.getItem("note") ?? ""
})
const remote = ref("")
async function load() {
  remote.value = await $fetch<string>("/api/note")
}
const draft = ref("")
const comments = ref<Array<{ body: string }>>([])
fetch("/api/comments").then((response) => response.json()).then((list) => { comments.value = list })
</script>
<template>
  <div v-html="bio" />
  <div v-html="saved" />
  <div v-html="remote" @click="load" />
  <textarea v-model="draft" />
  <div v-html="draft" />
  <div v-for="comment in comments" :key="comment.body" v-html="comment.body" />
  <div v-html="$route.params.slug" />
</template>`,
  });

  expect(diagnostics.map(({ line, severity, confidence }) => [line, severity, confidence])).toEqual(
    [
      [19, "error", "heuristic-high"],
      [20, "error", "heuristic-high"],
      [21, "error", "heuristic-high"],
      [23, "error", "heuristic-high"],
      [24, "error", "heuristic-high"],
      [25, "error", "heuristic-high"],
    ],
  );
  expect(diagnostics[0]!.why).toContain("`useRoute()`");
  expect(diagnostics[1]!.why).toContain("`localStorage`");
  expect(diagnostics[2]!.why).toContain("`$fetch()`");
  expect(diagnostics[3]!.why).toContain("v-model");
  expect(diagnostics[4]!.why).toContain("`fetch()`");
  expect(diagnostics[5]!.why).toContain("`$route`");
}, 30_000);

test("reports a prop it cannot trace as a low-confidence warning that says so", async () => {
  const diagnostics = await vHtml({
    "src/Rendered.vue": `<script setup lang="ts">
const props = defineProps<{ html: string; body: string }>()
</script>
<template>
  <div v-html="html" />
  <div v-html="props.body" />
</template>`,
  });

  expect(diagnostics).toEqual([
    expect.objectContaining({ line: 5, severity: "warn", confidence: "heuristic-low" }),
    expect.objectContaining({ line: 6, severity: "warn", confidence: "heuristic-low" }),
  ]);
  expect(diagnostics[0]!.why).toContain("the prop `html`");
  expect(diagnostics[0]!.why).toContain("could not trace");
  expect(diagnostics[1]!.why).toContain("the prop `body`");
}, 30_000);

test("skips Shiki, uqr, sanitizer output and literals", async () => {
  const diagnostics = await vHtml({
    "src/Code.vue": `<script setup lang="ts">
import { createHighlighter } from "shiki"
import { ref, watch } from "vue"
import DOMPurify from "dompurify"
import sanitizeHtml from "sanitize-html"
import { useRoute } from "vue-router"
import { qrCode } from "./qr"
const highlighter = createHighlighter({ themes: [], langs: [] })
const props = defineProps<{ content: string; url: string }>()
const route = useRoute()
const html = ref("")
watch(() => props.content, async (content) => {
  html.value = ""
  const instance = await highlighter!
  const rendered = instance.codeToHtml(content, { lang: "ts", theme: "github-dark" })
  html.value = rendered
}, { immediate: true })
const clean = DOMPurify.sanitize(String(route.query.bio))
const icon = "<svg><path d='M0 0' /></svg>"
</script>
<template>
  <div v-html="html" />
  <div v-html="qrCode(url)" />
  <div v-html="clean" />
  <div v-html="sanitizeHtml(props.content)" />
  <div v-html="icon" />
  <div v-html="\`<b>\${'static'}</b>\`" />
</template>`,
    "src/qr.ts": `import { renderSVG } from "uqr"
export function qrCode(url: string): string {
  return renderSVG(url, { border: 1 })
}`,
  });

  expect(diagnostics).toEqual([]);
}, 30_000);

test("treats a Markdown renderer as its input", async () => {
  const diagnostics = await vHtml({
    "src/Markdown.vue": `<script setup lang="ts">
import { computed } from "vue"
import MarkdownIt from "markdown-it"
import { marked } from "marked"
import { useRoute } from "vue-router"
const props = defineProps<{ source: string }>()
const md = new MarkdownIt({ html: true })
const route = useRoute()
const fromProp = computed(() => md.render(props.source))
const fromRoute = computed(() => marked.parse(String(route.query.text)))
const fixed = md.render("# Title")
</script>
<template>
  <div v-html="fromProp" />
  <div v-html="fromRoute" />
  <div v-html="fixed" />
</template>`,
  });

  expect(diagnostics.map(({ line, severity }) => [line, severity])).toEqual([
    [14, "warn"],
    [15, "error"],
  ]);
  expect(diagnostics[0]!.why).toContain("markdown-it");
  expect(diagnostics[1]!.why).toContain("`useRoute()`");
}, 30_000);

test("follows a Nuxt utils auto-import to its Shiki output", async () => {
  const diagnostics = await vHtml(
    {
      "nuxt.config.ts": "export default defineNuxtConfig({})",
      "app/utils/highlight.ts": `import { createHighlighter } from "shiki"
const highlighter = createHighlighter({ themes: [], langs: [] })
export async function highlightCodeLines(code: string, lang: string): Promise<string> {
  const html = (await highlighter!).codeToHtml(code, { lang, theme: "github-dark" })
  return (html.match(/<code>([\\s\\S]*)<\\/code>/)?.[1] ?? "").replaceAll("</span>\\n", "\\n</span>")
}`,
      "app/components/CodeTree.vue": `<script setup lang="ts">
const rewrite = shallowRef<{ code: string; html: string }>()
const shown = computed(() => (rewrite.value?.code ? rewrite.value : undefined))
async function update(code: string) {
  rewrite.value = undefined
  const html = await highlightCodeLines(code, "ts")
  rewrite.value = { code, html }
}
</script>
<template>
  <code v-if="shown" v-html="shown.html" @click="update('x')" />
</template>`,
    },
    "nuxt",
  );

  expect(diagnostics).toEqual([]);
}, 30_000);

test("does not retain trusted initializers across writes", async () => {
  const diagnostics = await vHtml({
    "src/Writes.vue": `<script setup>
import { reactive, ref } from "vue"
import { useRoute } from "vue-router"
const route = useRoute()
const state = reactive({ html: '' })
state.html = String(route.query.html)
const nested = ref({ html: '' })
nested.value.html = String(route.query.html)
let render = () => '<b>static</b>'
render = () => String(route.query.html)
const html = render()
</script>
<template><div v-html="state.html" /><div v-html="nested.html" /><div v-html="html" /></template>`,
  });
  expect(diagnostics.map(({ severity }) => severity)).toEqual(["error", "error", "warn"]);
});

test("requires provenance for renderer and sanitizer methods", async () => {
  const diagnostics = await vHtml({
    "src/Names.vue": `<script setup>
import { useRoute } from "vue-router"
const route = useRoute()
const renderer = { codeToHtml: input => input }
const DOMPurify = { sanitize: input => input }
const html = renderer.codeToHtml(String(route.query.html))
const clean = DOMPurify.sanitize(String(route.query.html))
</script>
<template><div v-html="html" /><div v-html="clean" /></template>`,
  });
  expect(diagnostics.map(({ severity }) => severity)).toEqual(["warn", "warn"]);
});

test("preserves selected properties through lists, parameters and model writes", async () => {
  const diagnostics = await vHtml({
    "src/Properties.vue": `<script setup>
import { reactive } from "vue"
import DOMPurify from "dompurify"
import { useRoute } from "vue-router"
const route = useRoute()
const item = { raw: String(route.query.html), html: DOMPurify.sanitize(String(route.query.html)) }
const items = [item]
function getHtml(item) { return item.html }
function getRaw(item) { return item.raw }
const form = reactive({ name: '', html: '<b>static</b>' })
</script>
<template>
<div v-for="item in items" v-html="item.html" />
<div v-html="getHtml(item)" />
<input v-model="form.name" /><div v-html="form.html" />
<div v-for="item in items" v-html="item.raw" />
<div v-html="getRaw(item)" /><div v-html="form.name" />
</template>`,
  });
  expect(diagnostics.map(({ severity }) => severity)).toEqual(["error", "error", "error"]);
});

test("distinguishes escaping, HTML-enabled and customized markdown-it", async () => {
  const diagnostics = await vHtml({
    "src/MarkdownModes.vue": `<script setup>
import MarkdownIt from "markdown-it"
import { useRoute } from "vue-router"
const route = useRoute()
const safe = new MarkdownIt()
const disabled = new MarkdownIt({ html: false })
const enabled = new MarkdownIt({ html: true })
const common = new MarkdownIt('commonmark')
const custom = new MarkdownIt()
custom.use(plugin)
</script>
<template>
<div v-html="safe.render(String(route.query.html))" />
<div v-html="safe.renderInline(String(route.query.html))" />
<div v-html="disabled.render(String(route.query.html))" />
<div v-html="enabled.render(String(route.query.html))" />
<div v-html="common.renderInline(String(route.query.html))" />
<div v-html="custom.render(String(route.query.html))" />
</template>`,
  });
  expect(diagnostics.map(({ severity }) => severity)).toEqual(["error", "error", "warn"]);
});
