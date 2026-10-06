import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const setupPositive = [
  "import * as Vue from 'vue'; export default Vue.defineComponent({ setup(props) { const { count } = props; return { count } } })",
  "const component = { setup(props) { const { count } = props; return { count } } }; export default component",
  "export default { setup(input) { const { count } = input; return { count } } }",
  "export default { setup: (input) => { const { count } = input; return { count } } }",
  "export default { setup: function (input) { const { count } = input; return { count } } }",
  "export default { setup(input = {}) { const { count } = input; return { count } } }",
  "export default { setup({ count }) { return { count } } }",
  "export default { setup(input) { if (enabled) { const { count } = input; use(count) } } }",
  "import { defineComponent as component } from 'vue'; export default component({ setup(input) { const { count } = input; return { count } } })",
  "import { defineComponent } from '#imports'; export default defineComponent(input => { const { count } = input; return () => count })",
  "export default ({ setup(props) { const { count } = props } } satisfies ComponentOptions)",
  "export default { setup: ((props: Props) => { const { count } = props }) as SetupFunction }",
];

const setupNegative = [
  "export default { setup(props) { const { count } = toRefs(props); return { count } } }",
  "export default { setup(props) { return () => { const { count } = props; return count } } }",
  "export default { setup(props) { { const props = plain(); const { count } = props } } }",
  "export default { setup(props) { function handler(props) { const { count } = props } } }",
  "const utilities = { setup(props) { const { count } = props; return count } }; export default {}",
  "import { defineComponent } from 'other'; export default defineComponent({ setup(props) { const { count } = props } })",
];

/**
 * A Nuxt project with positive and negative cases for every ported Rule, plus cases that probe
 * known host differences (mixed `<script>` + `<script setup>` blocks, template text before the
 * script, non-ASCII text before a finding).
 */
export function writeFixtureCorpus() {
  const root = mkdtempSync(join(tmpdir(), "vd-oxlint-fixtures-"));
  const files = {
    "package.json": JSON.stringify({
      name: "oxlint-host-fixtures",
      type: "module",
      dependencies: { nuxt: "^4.0.0", vue: "^3.5.0" },
    }),
    "nuxt.config.ts": "export default defineNuxtConfig({})\n",
    "public/logo.svg": "<svg/>\n",
    "app/utils/deserialize.ts": [
      "// é → non-ASCII before findings shifts UTF-8 offsets",
      "interface User { id: string }",
      "export const a = JSON.parse(text) as User",
      "export const b: User = JSON.parse(text)",
      "export const c = JSON.parse(text) as unknown",
      "export const d = JSON.parse(JSON.stringify(value)) as User",
      "export const e = window.localStorage.getItem('k') as string",
      "export function f(): User { return JSON.parse(text) }",
      "export const g = (): User => JSON.parse(text)",
      "export class H { user: User = JSON.parse(text) }",
      "export function local(JSON: { parse(v: string): unknown }) { return JSON.parse(text) as User }",
      "export async function i(): Promise<User> { return JSON.parse(await read()) }",
      "",
    ].join("\n"),
    "app/components/Deserialize.vue": [
      "<template><div>{{ user.id }}</div></template>",
      '<script setup lang="ts">',
      "const user = JSON.parse(text) as { id: string }",
      "</script>",
      "",
    ].join("\n"),
    "app/components/MixedBlocks.vue": [
      "<template><div /></template>",
      '<script lang="ts">',
      "const JSON = { parse: (value: string) => value }",
      "export default {}",
      "</script>",
      '<script setup lang="ts">',
      "const user = JSON.parse(text) as { id: string }",
      "</script>",
      "",
    ].join("\n"),
    "app/pages/fetch.vue": [
      '<script setup lang="ts">',
      "const posts = await $fetch('/api/posts')",
      "const raw = await fetch('/api/raw')",
      "const good = await useFetch('/api/good')",
      "</script>",
      "",
    ].join("\n"),
    "app/composables/useFetchOutside.ts": "export const data = await $fetch('/api/x')\n",
    "app/assets.ts": [
      "import logo from '~~/public/logo.svg'",
      "import root from '/public/logo.svg'",
      "import rel from '../public/logo.svg?url'",
      "import data from '../public/data.json'",
      "import src from '~/public/logo.svg'",
      "export const name = location.hash.slice(1)",
      "export const imageUrl = new URL(name, import.meta.url)",
      "export const iconUrl = new URL(`./icons/${name}.svg`, import.meta.url)",
      "export const staticUrl = new URL('./logo.svg', import.meta.url)",
      "fetch(new URL(name, import.meta.url))",
      "export { logo, root, rel, data, src }",
      "",
    ].join("\n"),
    "server/api/search.get.ts": [
      "export default defineEventHandler(async (event) => {",
      "  const query = getQuery(event)",
      "  const parsed = schema.parse(query)",
      "  return parsed",
      "})",
      "",
    ].join("\n"),
    "server/api/direct.get.ts": [
      "export default defineEventHandler(async (event) => {",
      "  const query = await getQuery(event)",
      "  validateQuery(query)",
      "  return query",
      "})",
      "",
    ].join("\n"),
    "server/api/clean.get.ts": [
      "export default defineEventHandler(async (event) => {",
      "  const query = getQuery(event)",
      "  return query",
      "})",
      "",
    ].join("\n"),
  };
  setupPositive.forEach((script, index) => {
    files[`app/components/SetupPositive${index}.vue`] = `<script lang="ts">${script}</script>\n`;
  });
  setupNegative.forEach((script, index) => {
    files[`app/components/SetupNegative${index}.vue`] = `<script lang="ts">${script}</script>\n`;
  });
  files["app/plugins/component.ts"] =
    "import { defineComponent } from 'vue'; export default defineComponent({ setup(input: { count: number }) { const { count } = input; return { count } } })\n";
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}
