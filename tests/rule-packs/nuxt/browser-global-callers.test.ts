import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { runViteDoctor } from "../../../src/doctor.js";
import { mergeAffectedRun, stateFromRun } from "../../../src/plugin-delta.js";
import { expect, test } from "vite-plus/test";
import { noBrowserGlobalInUniversalCode } from "../../../src/rule-packs/nuxt/rules/nuxt.ts";
import { runRuleFixture } from "../../../src/core/testkit.ts";

async function reported(files: Record<string, string>) {
  const result = await runRuleFixture({
    rule: noBrowserGlobalInUniversalCode,
    framework: "nuxt",
    files,
  });
  return result.diagnostics.map(
    (item) => `${item.file?.replace(/^.*?\/app\//, "app/")}:${item.range?.line}`,
  );
}

const figure = `export function mountFigure(host: HTMLElement) {
  const fig = document.createElement('div')
  host.append(fig)
  return fig
}
`;

test("a helper called only from onMounted is not reported (vitehub docs hero-figure/engine.ts:213)", async () => {
  expect(
    await reported({
      "app/utils/figure.ts": figure,
      "app/components/Figure.vue": `<script setup lang="ts">
import { mountFigure } from '~/utils/figure'
const host = useTemplateRef<HTMLElement>('host')
onMounted(() => {
  if (host.value) mountFigure(host.value)
})
</script>
<template><div ref="host" /></template>`,
    }),
  ).toEqual([]);
});

test("a helper whose callers Doctor cannot resolve is not reported", async () => {
  expect(
    await reported({
      "app/utils/figure.ts": figure,
      "app/utils/figures.ts": `import { mountFigure } from './figure'
export const figures = { hero: () => mountFigure }
`,
    }),
  ).toEqual([]);
});

test("a helper behind an import.meta.client guard or in a .client component is not reported", async () => {
  expect(
    await reported({
      "app/utils/figure.ts": figure,
      "app/pages/index.vue": `<script setup lang="ts">
import { mountFigure } from '../utils/figure'
if (import.meta.client) mountFigure(document.body)
</script>`,
      "app/components/Mount.client.vue": `<script setup lang="ts">
import { mountFigure } from '~/utils/figure'
mountFigure(document.body)
</script>`,
    }),
  ).toEqual([]);
});

test("a helper called while a page sets up is reported", async () => {
  expect(
    await reported({
      "app/utils/size.ts": `export function readWidth() {
  return window.innerWidth
}
`,
      "app/pages/index.vue": `<script setup lang="ts">
import { readWidth } from '~/utils/size'
const width = readWidth()
</script>
<template><span>{{ width }}</span></template>`,
    }),
  ).toEqual(["app/utils/size.ts:2"]);
});

test("an auto-imported helper called through another helper during setup is reported", async () => {
  expect(
    await reported({
      "app/utils/size.ts": `export const readWidth = () => window.innerWidth
export function describeWidth() {
  return \`\${readWidth()}px\`
}
`,
      "app/composables/useLayout.ts": `export function useLayout() {
  return { label: describeWidth() }
}
`,
    }),
  ).toEqual(["app/utils/size.ts:1"]);
});

test("a browser global in a composable body is still reported", async () => {
  expect(
    await reported({
      "app/composables/useWidth.ts": `export function useWidth() {
  return window.innerWidth
}
`,
    }),
  ).toEqual(["app/composables/useWidth.ts:2"]);
});

test.each(["tests/figure.test.ts", "test-utils/figure.ts", "nuxt.config.ts"])(
  "ignores non-runtime callers in %s",
  async (path) => {
    expect(
      await reported({
        "app/utils/figure.ts": figure,
        [path]: `import { mountFigure } from '~/utils/figure'; mountFigure(host)`,
      }),
    ).toEqual([]);
  },
);
test.each([
  `import { mountFigure } from './figure'; { const mountFigure = () => {}; mountFigure() }`,
  `import { mountFigure } from './figure'; export function useLayout(mountFigure: () => void) { mountFigure() }`,
  `export function mountFigure() { return window.innerWidth }; export function useLayout(mountFigure: () => void) { mountFigure() }`,
])("ignores shadowed helper calls: %s", async (source) => {
  expect(await reported({ "app/utils/figure.ts": figure, "app/utils/layout.ts": source })).toEqual(
    [],
  );
});

test.each([true, false])(
  "caller-only transitions preserve Plugin Surface and cache parity (cache=%s)",
  async (cache) => {
    const root = mkdtempSync(join(tmpdir(), "doctor-browser-callers-"));
    try {
      mkdirSync(join(root, "app/utils"), { recursive: true });
      mkdirSync(join(root, "app/pages"), { recursive: true });
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ dependencies: { nuxt: "4.0.0" } }),
      );
      writeFileSync(
        join(root, "app/utils/width.ts"),
        `export function readWidth() { return window.innerWidth }`,
      );
      const page = join(root, "app/pages/index.vue");
      const options = {
        root,
        framework: "nuxt" as const,
        runtimeTarget: {
          nuxt: "4.0.0",
          nitro: "2.0.0",
          h3: "1.0.0",
          vue: "3.5.0",
          nuxtCompatibility: 4 as const,
        },
        rules: noBrowserGlobalInUniversalCode.meta.id,
        cache,
      };
      const surface = (result: Awaited<ReturnType<typeof runViteDoctor>>) => ({
        diagnostics: result.diagnostics.map((diagnostic) => ({
          id: diagnostic.message,
          severity: diagnostic.severity,
          files: [diagnostic.file!, ...(diagnostic.related ?? []).map((site) => site.file)],
          summary: diagnostic.message,
          detail: diagnostic.message,
        })),
        evidenceGaps: [],
        runtimeIncomplete: false,
      });
      writeFileSync(page, `<script setup>onMounted(() => readWidth())</script>`);
      const initial = await runViteDoctor(options);
      let state = stateFromRun(surface(initial));
      expect(state.diagnostics.size).toBe(0);
      for (const ssr of [true, false, true]) {
        writeFileSync(
          page,
          ssr
            ? `<script setup>readWidth()</script>`
            : `<script setup>onMounted(() => readWidth())</script>`,
        );
        const scoped = await runViteDoctor({ ...options, affectedFiles: [page] });
        state = mergeAffectedRun(state, new Set([page]), surface(scoped));
        expect(state.diagnostics.size).toBe(ssr ? 1 : 0);
        if (ssr)
          expect(scoped.diagnostics[0]?.related?.[0]).toMatchObject({
            file: page,
            range: { line: 1, column: 15, start: 14, end: 25 },
          });
        const full = await runViteDoctor(options);
        expect(full.diagnostics.length).toBe(ssr ? 1 : 0);
        expect(full.diagnostics).toEqual(
          (await runViteDoctor({ ...options, cache: false })).diagnostics,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.each([true, false])(
  "intermediate-helper transitions preserve Plugin Surface and cache parity (cache=%s)",
  async (cache) => {
    const root = mkdtempSync(join(tmpdir(), "doctor-browser-callers-"));
    try {
      mkdirSync(join(root, "app/utils"), { recursive: true });
      mkdirSync(join(root, "app/pages"), { recursive: true });
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ dependencies: { nuxt: "4.0.0" } }),
      );
      writeFileSync(
        join(root, "app/utils/width.ts"),
        `export function readWidth() { return window.innerWidth }`,
      );
      const page = join(root, "app/utils/layout.ts");
      writeFileSync(join(root, "app/pages/index.vue"), `<script setup>describeWidth()</script>`);
      const options = {
        root,
        framework: "nuxt" as const,
        runtimeTarget: {
          nuxt: "4.0.0",
          nitro: "2.0.0",
          h3: "1.0.0",
          vue: "3.5.0",
          nuxtCompatibility: 4 as const,
        },
        rules: noBrowserGlobalInUniversalCode.meta.id,
        cache,
      };
      const surface = (result: Awaited<ReturnType<typeof runViteDoctor>>) => ({
        diagnostics: result.diagnostics.map((diagnostic) => ({
          id: diagnostic.message,
          severity: diagnostic.severity,
          files: [diagnostic.file!, ...(diagnostic.related ?? []).map((site) => site.file)],
          summary: diagnostic.message,
          detail: diagnostic.message,
        })),
        evidenceGaps: [],
        runtimeIncomplete: false,
      });
      writeFileSync(page, `export function describeWidth() { onMounted(() => readWidth()) }`);
      const initial = await runViteDoctor(options);
      let state = stateFromRun(surface(initial));
      expect(state.diagnostics.size).toBe(0);
      for (const ssr of [true, false, true]) {
        writeFileSync(
          page,
          ssr
            ? `export function describeWidth() { readWidth() }`
            : `export function describeWidth() { onMounted(() => readWidth()) }`,
        );
        const scoped = await runViteDoctor({ ...options, affectedFiles: [page] });
        state = mergeAffectedRun(state, new Set([page]), surface(scoped));
        expect(state.diagnostics.size).toBe(ssr ? 1 : 0);
        if (ssr)
          expect(scoped.diagnostics[0]?.related?.[1]).toMatchObject({
            file: page,
            range: { line: 1, column: 35, start: 34, end: 45 },
          });
        const full = await runViteDoctor(options);
        expect(full.diagnostics.length).toBe(ssr ? 1 : 0);
        expect(full.diagnostics).toEqual(
          (await runViteDoctor({ ...options, cache: false })).diagnostics,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
