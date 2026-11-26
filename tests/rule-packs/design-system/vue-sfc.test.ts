import { Linter } from "eslint";
import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  designSystemRules,
  noArbitraryValues,
  noRawColors,
} from "../../../src/rule-packs/design-system/index.ts";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import type { Diagnostic } from "../../../src/core/index.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const tailwind = { tailwindcss: "^4.0.0" };
const theme =
  '@import "tailwindcss";\n@theme { --color-primary: #3b82f6; --color-muted: #f4f4f5; }\n';

/** Each Diagnostic as [code, line, column, source text its range covers], in source order. */
function located(diagnostics: Diagnostic[], files: Record<string, string>) {
  return diagnostics
    .map((d) => {
      const path = Object.keys(files).find((file) => d.file.endsWith(file))!;
      return [
        d.code,
        d.range!.line,
        d.range!.column,
        files[path]!.slice(d.range!.start, d.range!.end),
      ] as const;
    })
    .toSorted((a, b) => a[1] - b[1] || a[2] - b[2] || a[0].localeCompare(b[0]));
}

const byText = (a: readonly string[], b: readonly string[]) =>
  a.join(" ").localeCompare(b.join(" "));

/** The 1-based line and column where `needle` starts in `source`. */
function at(source: string, needle: string, from = 0): [number, number] {
  const offset = source.indexOf(needle, from);
  if (offset === -1) throw new Error(`${needle} is not in the source`);
  const before = source.slice(0, offset).split("\n");
  return [before.length, before.at(-1)!.length + 1];
}

const card = [
  '<script setup lang="ts">',
  "const active = defineModel<boolean>();",
  "</script>",
  "",
  "<template>",
  '  <div class="bg-[#21201c] p-[13px]" style="color:#21201c">',
  "    <span :class=\"['text-red-500', active && 'm-[7px]']\" />",
  "    <span :class=\"{ 'bg-[#123456]': active }\" />",
  "    <p :style=\"{ color: '#ff0000' }\">x</p>",
  "  </div>",
  "</template>",
  "",
].join("\n");

test("reports template classes and styles of a Vue SFC at their template positions", async () => {
  const files = { "src/styles.css": theme, "src/Card.vue": card };
  const result = await runProjectFixture({
    framework: "vue",
    dependencies: tailwind,
    rules: designSystemRules,
    files,
  });
  const classes = '"bg-[#21201c] p-[13px]"';
  expect(located(result.diagnostics, files)).toEqual([
    ["DS0003", ...at(card, classes), classes],
    ["DS0003", ...at(card, classes), classes],
    ["DS0004", ...at(card, '"color:#21201c"'), '"color:#21201c"'],
    ["DS0002", ...at(card, "'text-red-500'"), "'text-red-500'"],
    ["DS0003", ...at(card, "'m-[7px]'"), "'m-[7px]'"],
    ["DS0003", ...at(card, "'bg-[#123456]'"), "'bg-[#123456]'"],
    ["DS0004", ...at(card, "'#ff0000'"), "'#ff0000'"],
  ]);
});

test("reports a class that :class resolves from <script setup> where the script declares it", async () => {
  const source = [
    '<script setup lang="ts">',
    'const tone = "bg-[#00ff00]";',
    "</script>",
    '<template><div :class="tone" /></template>',
    "",
  ].join("\n");
  const files = { "src/styles.css": theme, "src/Tone.vue": source };
  const result = await runProjectFixture({
    framework: "vue",
    dependencies: tailwind,
    rules: designSystemRules,
    files,
  });
  expect(located(result.diagnostics, files)).toEqual([
    ["DS0003", ...at(source, '"bg-[#00ff00]"'), '"bg-[#00ff00]"'],
  ]);
});

test("reports a template-only Vue SFC", async () => {
  const source = '<template>\n  <div class="text-red-500 p-[13px]" />\n</template>\n';
  const files = { "src/styles.css": theme, "src/Badge.vue": source };
  const result = await runProjectFixture({
    framework: "vue",
    dependencies: tailwind,
    rules: designSystemRules,
    files,
  });
  const classes = '"text-red-500 p-[13px]"';
  expect(located(result.diagnostics, files)).toEqual([
    ["DS0002", ...at(source, classes), classes],
    ["DS0003", ...at(source, classes), classes],
  ]);
});

const nuxtUiClasses = [
  "<template>",
  '  <div class="text-muted bg-elevated text-primary bg-default border-accented border-default">',
  '    <span class="text-highlighted text-dimmed text-toned text-inverted bg-muted bg-accented" />',
  '    <span class="bg-inverted ring-default divide-default outline-default text-error bg-success/10" />',
  '    <span class="text-secondary text-info text-warning bg-neutral text-default bg-primary/10" />',
  "  </div>",
  "</template>",
  "",
].join("\n");
const nuxtUiCss = [
  '@import "tailwindcss";',
  '@import "@nuxt/ui";',
  "",
  "@theme static {",
  '  --font-sans: "Public Sans", sans-serif;',
  "  --color-green-50: #effdf5;",
  "  --color-brand: #00c16a;",
  "}",
  "",
].join("\n");

test("Nuxt UI semantic color classes produce no Diagnostics in a Nuxt UI project", async () => {
  const files = { "src/assets/main.css": nuxtUiCss, "src/components/Panel.vue": nuxtUiClasses };
  const result = await runProjectFixture({
    framework: "vue",
    dependencies: { ...tailwind, "@nuxt/ui": "^4.0.0" },
    rules: designSystemRules,
    files,
  });
  expect(located(result.diagnostics, files)).toEqual([]);
});

test("the same classes are undeclared tokens in a project without Nuxt UI", async () => {
  const files = { "src/assets/main.css": nuxtUiCss, "src/components/Panel.vue": nuxtUiClasses };
  const result = await runProjectFixture({
    framework: "vue",
    dependencies: tailwind,
    rules: [noRawColors],
    files,
  });
  expect(result.diagnostics.length).toBeGreaterThan(0);
  expect(new Set(result.diagnostics.map((d) => d.code))).toEqual(new Set(["DS0002"]));
});

test("Nuxt UI projects accept the custom colors their config adds", async () => {
  const source = '<template>\n  <div class="text-tertiary bg-tertiary-100" />\n</template>\n';
  const files = {
    "nuxt.config.ts":
      "export default defineNuxtConfig({ modules: ['@nuxt/ui'], ui: { theme: { colors: ['primary', 'tertiary'] } } })\n",
    "src/assets/main.css": nuxtUiCss,
    "src/components/Tertiary.vue": source,
  };
  const result = await runProjectFixture({
    framework: "vue",
    dependencies: { ...tailwind, "@nuxt/ui": "^4.0.0" },
    rules: designSystemRules,
    files,
  });
  expect(located(result.diagnostics, files)).toEqual([]);
});

test("Nuxt UI projects still report raw palette classes, arbitrary colors, and unknown tokens", async () => {
  const source =
    '<template>\n  <div class="text-red-500 bg-[#123456] text-elevated" />\n</template>\n';
  const files = { "src/assets/main.css": nuxtUiCss, "src/components/Raw.vue": source };
  const result = await runProjectFixture({
    framework: "vue",
    dependencies: { ...tailwind, "@nuxt/ui": "^4.0.0" },
    rules: designSystemRules,
    files,
  });
  expect(result.diagnostics.map((d) => [d.code, d.why.split(" ")[0]]).toSorted(byText)).toEqual([
    ["DS0002", '"text-elevated"'],
    ["DS0002", '"text-red-500"'],
    ["DS0003", '"bg-[#123456]"'],
  ]);
});

const styled = [
  '<template><div class="card" /></template>',
  "",
  "<style scoped>",
  ".card {",
  "  color: #21201c;",
  "  background: linear-gradient(rgb(0 0 0 / 50%), OKLCH(0.7 0.1 200));",
  "  border-color: var(--color-border);",
  "  box-shadow: 0 0 0 1px rgb(var(--ring) / 0.5);",
  "  --accent: #ff0000;",
  "  outline-color: v-bind(\"theme.color ?? '#00ff00'\");",
  "  fill: url(#abc);",
  '  content: "#fff";',
  "  border: 1px solid red;",
  "  /* color: #c0ffee; */",
  "  mask-image: linear-gradient(rgba(0, 0, 0, 0), #d9d9d9);",
  "  -webkit-mask-image: linear-gradient(rgba(0, 0, 0, 0), #d9d9d9);",
  "}",
  "@theme {",
  "  --color-brand: #00c16a;",
  "}",
  "@media (prefers-color-scheme: dark) {",
  "  .card { color: hsl(0 0% 100%); }",
  "}",
  "</style>",
  "",
  '<style lang="scss">',
  "$brand: #ff0000;",
  "// a comment with #00ff00",
  ".a {",
  "  color: darken($brand, 10%);",
  "  &:hover { background: #abc; }",
  "}",
  "</style>",
  "",
  '<style lang="stylus">',
  ".b",
  "  color #123456",
  "</style>",
  "",
].join("\n");

test("reports color literals in <style> blocks under DS0002 at their SFC positions", async () => {
  const files = { "src/Styled.vue": styled };
  const result = await runProjectFixture({
    framework: "vue",
    dependencies: tailwind,
    rules: [noRawColors],
    files,
  });
  expect(located(result.diagnostics, files)).toEqual([
    ["DS0002", ...at(styled, "#21201c"), "#21201c"],
    ["DS0002", ...at(styled, "rgb(0 0 0 / 50%)"), "rgb(0 0 0 / 50%)"],
    ["DS0002", ...at(styled, "OKLCH(0.7 0.1 200)"), "OKLCH(0.7 0.1 200)"],
    ["DS0002", ...at(styled, "#abc;"), "#abc"],
  ]);
  const [first] = result.diagnostics;
  expect(first?.ruleId).toBe("design-system/no-raw-colors");
  expect(first?.why).toBe(
    'The <style> block hardcodes the color #21201c in "color". The color stays the same when the theme or dark mode changes, so it can clash with the rest of the interface or lose contrast.',
  );
  expect(first?.suggestion).toBe(
    "Replace #21201c with a theme color variable such as var(--color-<name>), and declare --color-<name> in the theme stylesheet first if the color is new.",
  );
  expect(first?.fix ?? null).toBeNull();
  expect(first?.confidence).toBe("heuristic-medium");
});

const themed = [
  '<template><div class="card" /></template>',
  "",
  "<style scoped>",
  ".card { color: light-dark(#21201c, #fafaf9); }",
  ".dark .card { color: #fafaf9; }",
  "html.dark-mode .card { color: #fafaf9; }",
  ":global(.light) .card { color: #21201c; }",
  '[data-theme="dark"] .card { color: #fafaf9; }',
  ":root[data-color-scheme='dark'] .card { color: #fafaf9; }",
  ".theme-midnight .card { color: #0b1020; }",
  ".theme-toggle { color: #0b1021; }",
  ".dark .card, .badge { color: #0b1022; }",
  ":is(.dark .card, .badge) { color: #0b1023; }",
  ":not(.dark) .card, .badge { color: #0b1024; }",
  '[data-mode="compact"] .card { color: #0b1025; }',
  '[title=".dark"] .card { color: #0b1026; }',
  "@media (prefers-color-scheme: dark) { .card { color: hsl(0 0% 100%); } }",
  "@media (prefers-color-scheme: dark), (min-width: 768px) { .card { color: #0b1027; } }",
  "@media (prefers-color-scheme: dark) or (min-width: 768px) { .card { color: #0b1028; } }",
  "@media not (prefers-color-scheme: dark) { .card { color: #0b1029; } }",
  "@variant light-hover { .card { color: #0b102a; } }",
  ".dark .card:not(.disabled) { color: #fff; }",
  '[data-theme="dark"] .card:nth-child(2) { color: #fff; }',
  ".dark :is(.card, .badge) { color: #fff; }",
  ".dark :is(.card, .badge), .outside { color: #0b102b; }",
  "@media (prefers-color-scheme: dark) and (min-width: 768px) { .card { color: #fff; } }",
  "@media screen and (prefers-color-scheme: dark) { .card { color: #fff; } }",
  "@media not screen and (prefers-color-scheme: dark) { .card { color: #0b102c; } }",
  "@media ((prefers-color-scheme: dark) or (min-width: 768px)) and (color) { .card { color: #0b102d; } }",
  "@variant dark { .card { color: #fafaf9; } }",
  ".dark-gray { color: #111111; }",
  ".darkness .card { color: #222222; }",
  "</style>",
  "",
  '<style lang="scss">',
  ".card {",
  "  .dark & { background: #18181b; }",
  "  &.dark { background: #18181b; }",
  "  background: #ffffff;",
  "}",
  "</style>",
  "",
].join("\n");

test("skips <style> colors that define a color scheme or theme variant", async () => {
  const files = { "src/Themed.vue": themed };
  const result = await runProjectFixture({
    framework: "vue",
    dependencies: tailwind,
    rules: [noRawColors],
    files,
  });
  const reported = [...themed.matchAll(/#0b102[0-9a-d]/g)].map(([text]) => text);
  expect(located(result.diagnostics, files)).toEqual(
    [...reported, "#111111", "#222222", "#ffffff"].map((text) => [
      "DS0002",
      ...at(themed, text),
      text,
    ]),
  );
});

test("uses the theme condition that survives Vue's scoped global selector rewrite", async () => {
  const source = [
    '<template><div class="card" /></template>',
    "<style scoped>",
    ".dark :global(.card:hover) { color: #123456; }",
    '[data-theme="dark"] ::v-global(.card:focus) { color: #234567; }',
    ":global(.dark) { color: #345678; }",
    ".dark .card:hover { color: #456789; }",
    ":global(.card).dark { color: #567890; }",
    ":global(.dark), .card { color: #678901; }",
    '::v-global([data-theme="dark"] .card) { color: #789012; }',
    "</style>",
  ].join("\n");
  const files = { "src/Card.vue": source };
  const result = await runProjectFixture({
    framework: "vue",
    dependencies: tailwind,
    rules: [noRawColors],
    files,
  });
  expect(located(result.diagnostics, files)).toEqual(
    ["#123456", "#234567", "#567890", "#678901"].map((text) => [
      "DS0002",
      ...at(source, text),
      text,
    ]),
  );
});

test.each(["module", 'module="theme"'])(
  "preserves the theme condition in Vue CSS Modules (%s)",
  async (attribute) => {
    const source = [
      "<template><div /></template>",
      `<style ${attribute}>`,
      ":global(.dark) .card { color: #123456; }",
      ".card:global(.light) { color: #345678; }",
      ".card { background-color: #234567; }",
      ":global(.dark) .card, .badge { color: #456789; }",
      ":not(:global(.dark)) .card { color: #567890; }",
      "</style>",
    ].join("\n");
    const files = { "src/Card.vue": source };
    const result = await runProjectFixture({
      framework: "vue",
      dependencies: tailwind,
      rules: [noRawColors],
      files,
    });
    expect(located(result.diagnostics, files)).toEqual(
      ["#234567", "#456789", "#567890"].map((text) => ["DS0002", ...at(source, text), text]),
    );
  },
);

test("does not inherit a CSS Module theme from an enclosing selector alone", async () => {
  const source = [
    "<template><div /></template>",
    "<style module>",
    ":global(.dark) {",
    "  :is(&, .card) { color: #123456; }",
    "  @supports (display: grid) { color: #223456; }",
    "}",
    "@media (prefers-color-scheme: dark) {",
    "  .card { :is(&, .badge) { color: #323456; } }",
    "  @scope (.panel) { .card { color: #423456; } }",
    "  @keyframes flash { to { color: #523456; } }",
    "}",
    "</style>",
    '<style module="theme" lang="scss">',
    ":global(.dark) {",
    "  @at-root .card { color: #234567; }",
    "  @keyframes flash { to { color: #345678; } }",
    "}",
    "@media (prefers-color-scheme: dark) {",
    "  @at-root (without: media) { .card { color: #623456; } }",
    "  @keyframes flash { to { color: #723456; } }",
    "}",
    ".card { :global(.dark) & { color: #456789; } }",
    "</style>",
  ].join("\n");
  const files = { "src/Card.vue": source };
  const result = await runProjectFixture({
    framework: "vue",
    dependencies: tailwind,
    rules: [noRawColors],
    files,
  });
  expect(located(result.diagnostics, files)).toEqual(
    ["#123456", "#234567", "#345678", "#623456"].map((text) => [
      "DS0002",
      ...at(source, text),
      text,
    ]),
  );
});

test("points <style> fixes at Nuxt UI's color variables in a Nuxt UI project", async () => {
  const source = "<template><div /></template>\n<style>\ndiv { color: #21201c; }\n</style>\n";
  const result = await runProjectFixture({
    framework: "vue",
    dependencies: { ...tailwind, "@nuxt/ui": "^4.0.0" },
    rules: [noRawColors],
    files: { "src/Box.vue": source },
  });
  expect(result.diagnostics.map((d) => d.suggestion)).toEqual([
    "Replace #21201c with a Nuxt UI color variable such as var(--ui-primary) or var(--ui-text-muted), or a theme variable declared in the theme stylesheet.",
  ]);
});

test("skips <style> blocks of the design system's own components", async () => {
  const source = "<template><button /></template>\n<style>\nbutton { color: #21201c; }\n</style>\n";
  const result = await runProjectFixture({
    framework: "vue",
    dependencies: tailwind,
    rules: [noRawColors],
    files: { "src/components/ui/button/Button.vue": source },
  });
  expect(result.diagnostics).toEqual([]);
});

test("skips colors inside an SVG mask, which set luminance rather than paint", async () => {
  const source = [
    "<template>",
    '  <svg fill="none">',
    '    <mask id="m" fill="white"><path fill="#ffffff" d="M0 0H1V1H0Z" /></mask>',
    '    <path fill="#21201c" d="M0 0H1V1H0Z" />',
    "  </svg>",
    "</template>",
    "",
  ].join("\n");
  const files = { "src/styles.css": theme, "src/Hero.vue": source };
  const result = await runProjectFixture({
    framework: "vue",
    dependencies: tailwind,
    rules: [noRawColors],
    files,
  });
  expect(located(result.diagnostics, files).map(([code, line]) => [code, line])).toEqual([
    ["DS0002", 4],
  ]);
});

test("accepts arbitrary grid track lists and transition properties, which have no scale", async () => {
  const source = [
    "<template>",
    '  <div class="grid md:grid-cols-[14rem_minmax(0,1fr)] grid-rows-[auto_1fr]" />',
    '  <div class="transition-[width,color] h-[13px]" />',
    '  <div class="transition-[opacity,transform] transition-[--progress,opacity] grid-cols-[minmax(0,clamp(10rem,20vw,20rem))_1fr]" />',
    '  <div class="transition-[opacity] transition-[transform,translate,scale,rotate] grid-rows-[subgrid] grid-cols-[repeat(2,minmax(0,1fr))]" />',
    "</template>",
    "",
  ].join("\n");
  const files = { "src/styles.css": theme, "src/Layout.vue": source };
  const result = await runProjectFixture({
    framework: "vue",
    dependencies: tailwind,
    rules: [noArbitraryValues],
    files,
  });
  expect(result.diagnostics.map((d) => [d.code, d.why.split(" ")[0]]).toSorted(byText)).toEqual(
    [
      "h-[13px]",
      "transition-[opacity]",
      "transition-[transform,translate,scale,rotate]",
      "grid-rows-[subgrid]",
      "grid-cols-[repeat(2,minmax(0,1fr))]",
    ]
      .map((token) => ["DS0003", `"${token}"`])
      .toSorted(byText),
  );
});

test.each([
  { deny: ["transition-*", "grid-cols-*"] },
  { options: { deny: ["transition-*", "grid-cols-*"] }, settings: { note: "See DESIGN.md." } },
])("honors the project's arbitrary-value policy (%j)", async (options) => {
  const result = await runProjectFixture({
    framework: "vue",
    dependencies: tailwind,
    rules: [noArbitraryValues],
    config: { rules: { "design-system/no-arbitrary-values": ["warn", options] } },
    files: {
      "src/styles.css": theme,
      "src/Layout.vue":
        '<template><div class="transition-[width,color] grid-cols-[14rem_1fr]" /></template>',
    },
  });
  expect(result.diagnostics.map((d) => d.code)).toEqual(["DS0003", "DS0003"]);
});

test("skips gradient stops that only an SVG mask references", async () => {
  const source = [
    "<template>",
    "  <svg>",
    "    <defs>",
    '      <linearGradient :id="`${id}-fade`"><stop stop-color="#fff" /></linearGradient>',
    '      <linearGradient id="paint"><stop stop-color="#21201c" /></linearGradient>',
    '      <mask :id="`${id}-window`"><rect :fill="`url(#${id}-fade)`" /></mask>',
    "    </defs>",
    '    <rect fill="url(#paint)" :mask="`url(#${id}-window)`" />',
    "  </svg>",
    "</template>",
    "",
  ].join("\n");
  const files = { "src/styles.css": theme, "src/Motion.vue": source };
  const result = await runProjectFixture({
    framework: "vue",
    dependencies: tailwind,
    rules: [noRawColors],
    files,
  });
  expect(located(result.diagnostics, files).map(([code, line]) => [code, line])).toEqual([
    ["DS0002", 5],
  ]);
});

test.each([
  ['<rect fill="url( &apos;#fade&apos; )" />', '<rect fill="url(#fade)" />'],
  [
    '<linearGradient id="paint" href="#fade" /><rect fill="url(#paint)" />',
    '<rect fill="url(#fade)" />',
  ],
  ["", '<!-- <rect fill="url(#fade)" /> -->'],
  ['<rect :fill="paint" />', '<rect fill="url(#fade)" />'],
])("reports gradient colors unless use is provably mask-only (%s / %s)", async (paint, mask) => {
  const source = `<template><svg><defs>
    <linearGradient id="fade"><stop stop-color="#123456" /></linearGradient>
    <mask>${mask}</mask>
  </defs>${paint}</svg></template>`;
  const result = await runProjectFixture({
    framework: "vue",
    dependencies: tailwind,
    rules: [noRawColors],
    files: { "src/styles.css": theme, "src/Motion.vue": source },
  });
  expect(result.diagnostics.map((d) => d.code)).toEqual(["DS0002"]);
});

test("accepts arbitrary content values, which Tailwind has no scale for", async () => {
  const source =
    "<template>\n  <span class=\"after:content-['']\" />\n  <span class=\"before:content-['a:b'] p-[13px]\" />\n</template>\n";
  const files = { "src/styles.css": theme, "src/Pseudo.vue": source };
  const result = await runProjectFixture({
    framework: "vue",
    dependencies: tailwind,
    rules: designSystemRules,
    files,
  });
  expect(result.diagnostics.map((d) => [d.code, d.why.split(" ")[0]])).toEqual([
    ["DS0003", '"p-[13px]"'],
  ]);
});

test("skips OG image templates, which render to an image through Satori or Takumi", async () => {
  const source =
    '<template>\n  <div class="bg-[#00dc82]" style="color:#21201c"><svg><path fill="#00DC82" /></svg></div>\n</template>\n';
  const result = await runProjectFixture({
    framework: "vue",
    dependencies: { ...tailwind, "nuxt-og-image": "^5.0.0" },
    rules: designSystemRules,
    files: { "src/styles.css": theme, "src/components/OgImage/Saas.takumi.vue": source },
  });
  expect(result.diagnostics).toEqual([]);
});

function applied(source: string, diagnostic: Diagnostic | undefined): string {
  const edit = diagnostic?.fix?.edits?.[0];
  if (!edit) throw new Error("the Diagnostic has no edit");
  return source.slice(0, edit.range.start) + edit.text + source.slice(edit.range.end);
}

test.each(["tsx", "jsx"])(
  "reports template classes of an SFC whose script uses %s",
  async (lang) => {
    const source = `<script setup lang="${lang}">\nconst render = () => <div />;\n</script>\n<template>\n  <div class="text-red-500" />\n</template>\n`;
    const files = { "src/styles.css": theme, "src/Render.vue": source };
    const result = await runProjectFixture({
      framework: "vue",
      dependencies: tailwind,
      rules: [noRawColors],
      files,
    });
    expect(located(result.diagnostics, files)).toEqual([
      ["DS0002", ...at(source, '"text-red-500"'), '"text-red-500"'],
    ]);
    expect(result.project.evidenceGaps ?? []).toEqual([]);
  },
);

test("reports an evidence gap when ESLint cannot parse an SFC that Doctor parsed", async () => {
  const fatal = {
    ruleId: null,
    fatal: true,
    severity: 2,
    message: "Parsing error",
    line: 1,
    column: 1,
  };
  vi.spyOn(Linter.prototype, "verify").mockReturnValue([fatal] as Linter.LintMessage[]);
  const result = await runProjectFixture({
    framework: "vue",
    dependencies: tailwind,
    rules: [noRawColors],
    files: {
      "src/styles.css": theme,
      "src/Parsed.vue": '<template>\n  <div class="text-red-500" />\n</template>\n',
    },
  });
  expect(result.project.evidenceGaps).toEqual([
    expect.objectContaining({ source: "vite-doctor/design-system", files: ["src/Parsed.vue"] }),
  ]);
});

test("adds no second evidence gap for an SFC script Doctor could not parse either", async () => {
  const source =
    '<script setup lang="ts">\nconst = ;\n</script>\n<template>\n  <div class="text-red-500" />\n</template>\n';
  const result = await runProjectFixture({
    framework: "vue",
    dependencies: tailwind,
    rules: [noRawColors],
    files: { "src/styles.css": theme, "src/Broken.vue": source },
  });
  expect(result.project.evidenceGaps?.map((gap) => gap.source)).toEqual(["script-parser"]);
});

test("an edit for a Vue template class applies and compiles, including in a BOM-prefixed SFC", async () => {
  const { parse, compileTemplate } = await import("@vue/compiler-sfc");
  for (const source of [
    "<template>\n  <div :class=\"'p-[13px]'\" />\n</template>\n",
    '﻿<template>\n  <div class="p-[13px]" />\n</template>\n',
  ]) {
    const result = await runProjectFixture({
      framework: "vue",
      dependencies: tailwind,
      rules: [noArbitraryValues],
      files: { "src/styles.css": theme, "src/Box.vue": source },
    });
    const fixed = applied(source, result.diagnostics[0]);
    expect(fixed).toBe(source.replace("p-[13px]", "p-3.25"));
    const { descriptor, errors } = parse(fixed);
    expect(errors).toEqual([]);
    const compiled = compileTemplate({
      source: descriptor.template!.content,
      filename: "Box.vue",
      id: "box",
    });
    expect(compiled.errors).toEqual([]);
  }
});

test("offers no edit when the template attribute encodes characters the edit would decode", async () => {
  const source =
    "<template>\n  <div :class=\"'p-[13px] before:content-[&quot;hi&quot;]'\" />\n</template>\n";
  const result = await runProjectFixture({
    framework: "vue",
    dependencies: tailwind,
    rules: [noArbitraryValues],
    files: { "src/styles.css": theme, "src/Quote.vue": source },
  });
  expect(result.diagnostics.map((d) => [d.code, d.fix ?? null])).toEqual([["DS0003", null]]);
  expect(result.diagnostics[0]?.suggestion).toContain("p-3.25");
});

test("Nuxt UI tokens stay exempt when a custom message or settings note rewrites the finding", async () => {
  const source =
    "<template>\n  <div class=\"text-muted bg-primary/10 after:content-['']\" />\n</template>\n";
  for (const options of [
    { message: "Use approved colors" },
    { settings: { note: "See DESIGN.md." } },
  ]) {
    const result = await runProjectFixture({
      framework: "vue",
      dependencies: { ...tailwind, "@nuxt/ui": "^4.0.0" },
      rules: [noRawColors, noArbitraryValues],
      config: {
        rules: {
          "design-system/no-raw-colors": ["warn", options],
          "design-system/no-arbitrary-values": ["warn", options],
        },
      },
      files: { "src/assets/main.css": nuxtUiCss, "src/Muted.vue": source },
    });
    expect(result.diagnostics).toEqual([]);
  }
});

test.each([
  ["plain array", "colors: ['tertiary']", true],
  ["type assertions", "colors: (['tertiary'] as const) satisfies readonly string[]", true],
  ["template literal", "colors: [`terti\\u0061ry`]", true],
  ["static computed keys", "[`colors`]: ['tertiary'], ['transitions']: false, [1]: true", true],
  ["unknown computed key", "colors: ['tertiary'], [key]: ['warning']", false],
  ["unknown spread", "colors: ['tertiary'], ...other", false],
  ["overridden spread", "...other, colors: ['tertiary']", true],
])(
  "Nuxt UI reads the effective ui.theme.colors (%s) and ignores comments",
  async (_, properties, custom) => {
    const source =
      '<template>\n  <div class="text-tertiary text-primary text-neutral text-warning text-red-500" />\n</template>\n';
    const files = {
      "nuxt.config.ts": [
        "// ui: { theme: { colors: ['red'] } }",
        "const sample = { ui: { theme: { colors: ['red'] } } }",
        "const example = `ui: { theme: { colors: ['red'] } }`",
        "const key = 'colors'",
        "const other = { colors: ['warning'] }",
        "export default defineNuxtConfig({",
        "  modules: ['@nuxt/ui'],",
        `  ui: { theme: { ${properties} } },`,
        "})",
        "",
      ].join("\n"),
      "src/assets/main.css": nuxtUiCss,
      "src/components/Colors.vue": source,
    };
    const result = await runProjectFixture({
      framework: "vue",
      dependencies: { ...tailwind, "@nuxt/ui": "^4.0.0" },
      rules: [noRawColors],
      files,
    });
    expect(result.diagnostics.map((d) => d.why.split(" ")[0]).toSorted()).toEqual([
      '"text-red-500"',
      custom ? '"text-warning"' : '"text-tertiary"',
    ]);
  },
);

test("reads the theme of the imported Nuxt UI Vite plugin, not an unrelated ui call", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    dependencies: { ...tailwind, "@nuxt/ui": "^4.0.0" },
    rules: [noRawColors],
    files: {
      "vite.config.ts": [
        "import { defineConfig } from 'vite'",
        "import uiPlugin from '@nuxt/ui/vite'",
        "const ui = (value: unknown) => value",
        "export default defineConfig({ plugins: [ui({theme: {colors: ['red']}}), uiPlugin({theme: {colors: [`tertiary`] as const, ['transitions']: false}} satisfies unknown)] })",
      ].join("\n"),
      "src/assets/main.css": nuxtUiCss,
      "src/Colors.vue":
        '<template><div class="text-tertiary text-warning text-red-500" /></template>',
    },
  });
  expect(result.diagnostics.map((d) => d.why.split(" ")[0]).toSorted()).toEqual([
    '"text-red-500"',
    '"text-warning"',
  ]);
});

test("reports colors after a self-closing or commented-out SVG mask", async () => {
  const source = [
    "<template>",
    "  <svg>",
    '    <mask id="a" />',
    '    <path fill="#123456" />',
    '    <!-- <mask id="b"> -->',
    '    <path fill="#654321" />',
    "  </svg>",
    "</template>",
    "",
  ].join("\n");
  const files = { "src/styles.css": theme, "src/Masked.vue": source };
  const result = await runProjectFixture({
    framework: "vue",
    dependencies: tailwind,
    rules: [noRawColors],
    files,
  });
  expect(located(result.diagnostics, files).map(([code, line]) => [code, line])).toEqual([
    ["DS0002", 4],
    ["DS0002", 6],
  ]);
});

test("reports an OgImage directory without Nuxt OG Image", async () => {
  const source = '<template>\n  <div class="bg-[#00dc82]" />\n</template>\n';
  const result = await runProjectFixture({
    framework: "vue",
    dependencies: tailwind,
    rules: designSystemRules,
    files: { "src/styles.css": theme, "src/components/OgImage/Preview.vue": source },
  });
  expect(result.diagnostics.map((d) => d.code)).toEqual(["DS0003"]);
});

const scanned = [
  "<template><div /></template>",
  "",
  "<style>",
  ".a { color: rgb(from currentColor r g b / 50%); }",
  ".b { color: color-mix(in srgb, var(--color-primary), #000000 10%); }",
  ".c { color: rgb(/** ) */255 0 0); }",
  ".d { color: rgb(255 0 0 /* currentColor */); }",
  ".e { color: color-mix(in srgb, #123456, #fedcba /* var(--unused) */); }",
  ".f { color: rgb(/* comment */ from /* another */ #999 r g b); }",
  ".g { color: color-mix(in srgb, currentColor, #aaa); }",
  "</style>",
  "",
  '<style lang="scss">',
  ".card-#{$name} { color: var(--x); }",
  "$channel: var(--theme-r);",
  ".dynamic { color: rgb(#{$channel} 0 0); }",
  ".dynamic-mix { color: color-mix(in srgb, #{$channel}, #ff0); }",
  ".fixed { color: rgb(1 // var(--unused)",
  "  2 3); }",
  ".other { color: #00ff00; }",
  "</style>",
  "",
  '<style lang="less">',
  ".card-@{name} { color: var(--x); }",
  "@channel: var(--theme-r);",
  ".dynamic { color: rgb(@{channel} 0 0); }",
  ".more { color: #0000ff; }",
  "</style>",
  "",
].join("\n");

test("reads relative colors, color-mix, comments, and preprocessor interpolation in <style>", async () => {
  const files = { "src/Scanned.vue": scanned };
  const result = await runProjectFixture({
    framework: "vue",
    dependencies: tailwind,
    rules: [noRawColors],
    files,
  });
  expect(located(result.diagnostics, files)).toEqual([
    ["DS0002", ...at(scanned, "rgb(/**"), "rgb(/** ) */255 0 0)"],
    ["DS0002", ...at(scanned, "rgb(255"), "rgb(255 0 0 /* currentColor */)"],
    ["DS0002", ...at(scanned, "#123456"), "#123456"],
    ["DS0002", ...at(scanned, "#fedcba"), "#fedcba"],
    ["DS0002", ...at(scanned, "rgb(1 //"), "rgb(1 // var(--unused)\n  2 3)"],
    ["DS0002", ...at(scanned, "#00ff00"), "#00ff00"],
    ["DS0002", ...at(scanned, "#0000ff"), "#0000ff"],
  ]);
});
