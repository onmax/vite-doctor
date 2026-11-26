import { expect, test } from "vite-plus/test";
import { nuxtAppInputSignature } from "../../../src/core/internal/nuxt-app-inputs.ts";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import { runViteDoctor } from "../../../src/doctor.ts";
import {
  limitPerView,
  parseContract,
  unreadableContract,
} from "../../../src/rule-packs/design-system/index.ts";
import { withFixture, writeFileManifest } from "../nuxt/nuxt-modern-rules-fixture.ts";

const NUXT_UI = { "@nuxt/ui": "^4.0.0" };
const WHY = "Two primary buttons compete and the user can't tell which one moves them forward.";
const FIX = 'Keep one primary AppButton and give the others variant="secondary".';

const appButton = `<script setup lang="ts">
withDefaults(defineProps<{ variant?: string }>(), { variant: "secondary" });
defineOptions({
  doctor: {
    limits: [{ when: { variant: "primary" }, max: 1, why: ${JSON.stringify(WHY)}, fix: ${JSON.stringify(FIX)} }],
  },
});
</script>

<template><button :class="variant"><slot /></button></template>
`;

const app = `<template><NuxtLayout><NuxtPage /></NuxtLayout></template>`;
const layout = (body = "") => `<template><div>${body}<slot /></div></template>`;
const page = (body: string, script = "") =>
  `${script ? `<script setup lang="ts">\n${script}\n</script>\n` : ""}<template><main>${body}</main></template>`;
const primary = `<AppButton variant="primary">Save</AppButton>`;

const diagnose = (
  files: Record<string, string>,
  config?: object,
  dependencies?: Record<string, string>,
) =>
  runProjectFixture({
    rules: [limitPerView, unreadableContract],
    framework: "nuxt",
    ...(dependencies && { dependencies }),
    ...(config && { config: { rules: { "design-system/limit-per-view": ["warn", config] } } }),
    files: {
      "app/app.vue": app,
      "app/components/AppButton.vue": appButton,
      ...files,
    },
  });

const limitDiagnostics = async (...args: Parameters<typeof diagnose>) =>
  (await diagnose(...args)).diagnostics.filter((item) => item.code === "DS0008");

test("a page and its layout with one primary each report once, at the page's button", async () => {
  const result = await diagnose({
    "app/layouts/default.vue": layout(primary),
    "app/pages/index.vue": page(primary),
    "app/pages/about.vue": page("<p>About</p>"),
  });

  expect(result.diagnostics).toHaveLength(1);
  const [diagnostic] = result.diagnostics;
  expect(diagnostic).toMatchObject({
    code: "DS0008",
    ruleId: "design-system/limit-per-view",
    file: expect.stringContaining("app/pages/index.vue"),
    confidence: "proven",
  });
  expect(diagnostic?.why).toBe(
    `More than 1 primary <AppButton> in the / view: 2 render together. ${WHY}`,
  );
  expect(diagnostic?.suggestion).toBe(
    `${FIX} Counted usages: app/layouts/default.vue:1:17, app/pages/index.vue:1:18.`,
  );
  expect(diagnostic?.evidence).toHaveLength(3);
  expect(diagnostic?.data).toMatchObject({ routes: ["/"], max: 1 });
});

test("two primaries in a layout report once, not once per page", async () => {
  const result = await limitDiagnostics({
    "app/layouts/default.vue": layout(primary + primary),
    "app/pages/index.vue": page("<p>Home</p>"),
    "app/pages/about.vue": page("<p>About</p>"),
  });

  expect(result).toHaveLength(1);
  expect(result[0]?.file).toContain("app/layouts/default.vue");
  expect(result[0]?.why).toContain("and 1 other view that share these usages");
});

test("a nested parent page and child page report in the child's view", async () => {
  const result = await limitDiagnostics({
    "app/pages/settings.vue": page(`${primary}<NuxtPage />`),
    "app/pages/settings/profile.vue": page(primary),
  });

  expect(result).toHaveLength(1);
  expect(result[0]?.file).toContain("app/pages/settings/profile.vue");
  expect(result[0]?.why).toContain("the /settings/profile view");
});

test("uses the prepared full path of a nested route", async () => {
  const parent = "app/pages/settings.vue";
  const child = "app/pages/settings/profile.vue";
  await withFixture(
    {
      "app/app.vue": app,
      "app/components/AppButton.vue": appButton,
      [parent]: page(`${primary}<NuxtPage />`),
      [child]: page(primary),
    },
    NUXT_UI,
    async (root) => {
      const inputs = {
        directories: [{ directory: "app/pages", patterns: ["**/*.vue"] }],
        files: [],
        ignore: { patterns: [], roots: ["."] },
      };
      await writeFileManifest(root, [], {
        generatedAt: new Date(Date.now() + 10_000).toISOString(),
        pages: [
          { path: "/custom", fullPath: "/custom", file: parent, parentFile: null },
          { path: ":id", fullPath: "/custom/:id", file: child, parentFile: parent },
        ],
        resolvedApp: {
          pagesResolved: true,
          inputs: { pages: { ...inputs, signature: nuxtAppInputSignature(root, inputs) } },
        },
      });
      const result = await runViteDoctor({ root, framework: "nuxt", cache: false });
      expect(result.diagnostics.filter(({ code }) => code === "DS0008")).toMatchObject([
        { data: { routes: ["/custom/:id"], pages: [child] } },
      ]);
    },
  );
});

test("a usage passed through a resolved wrapper's default slot counts", async () => {
  const result = await limitDiagnostics({
    "app/components/Toolbar.vue": `<template><div class="toolbar"><slot /></div></template>`,
    "app/pages/index.vue": page(`<Toolbar>${primary}</Toolbar>${primary}`),
  });

  expect(result).toHaveLength(1);
  expect(result[0]?.confidence).toBe("proven");
});

test("a dynamic slot binding on the host is not treated as its default slot", async () => {
  const result = await limitDiagnostics({
    "app/components/Toolbar.vue": `<template><div><slot /></div></template>`,
    "app/pages/index.vue": page(`<Toolbar v-slot:[name]>${primary}</Toolbar>${primary}`),
  });

  expect(result).toEqual([]);
});

test("a usage in a package component's default slot counts as heuristic-high", async () => {
  const result = await limitDiagnostics({
    "app/pages/index.vue": page(`<UCard>${primary}</UCard>${primary}`),
  });

  expect(result).toHaveLength(1);
  expect(result[0]?.confidence).toBe("heuristic-high");
});

test("an omitted prop counts when the component's literal default matches", async () => {
  const result = await limitDiagnostics({
    "app/components/AppButton.vue": appButton.replace('variant: "secondary"', 'variant: "primary"'),
    "app/pages/index.vue": page(`<AppButton>Save</AppButton><AppButton>Publish</AppButton>`),
  });

  expect(result).toHaveLength(1);
});

test("a config contract on Nuxt UI's UButton counts bare and solid primary buttons", async () => {
  const contracts = {
    UButton: {
      limits: [
        {
          when: { variant: ["solid", null], color: ["primary", null] },
          max: 1,
          why: "Two solid primary buttons compete for the same click.",
          fix: 'Keep one solid primary UButton and give the others variant="outline" or color="neutral".',
        },
      ],
    },
  };
  const body = page(
    `<UButton>Save</UButton><UButton variant="outline">Cancel</UButton><UButton color="primary" variant="solid">Publish</UButton>`,
  );
  const result = await limitDiagnostics({ "app/pages/index.vue": body }, { contracts }, NUXT_UI);

  expect(result).toHaveLength(1);
  expect(result[0]?.why).toContain("More than 1 solid primary <UButton> in the / view");
  expect(result[0]?.range?.column).toBe(body.indexOf('<UButton color="primary"') + 2);
});

test.each([
  [
    "a v-if/v-else pair",
    `<AppButton v-if="a" variant="primary" /><AppButton v-else variant="primary" />${primary}`,
  ],
  ["v-show", `<AppButton v-show="a" variant="primary" />${primary}`],
  ["v-for", `<AppButton v-for="item in items" :key="item" variant="primary" />${primary}`],
  ["a UModal #footer", `<UModal><template #footer>${primary}</template></UModal>${primary}`],
  ["a UModal default slot", `<UModal>${primary}</UModal>${primary}`],
  ["a bound variant", `<AppButton :variant="tone" />${primary}`],
  ["a v-bind spread", `<AppButton v-bind="attrs" variant="primary" />${primary}`],
  [
    "a dynamic component",
    `<component :is="AppButton" variant="primary" /><component :is="tag">${primary}</component>${primary}`,
  ],
  ["a Teleport", `<Teleport to="body">${primary}</Teleport>${primary}`],
  [
    "a package component's named slot",
    `<UCard><template #footer>${primary}</template></UCard>${primary}`,
  ],
  ["a wrapper whose slot is conditional", `<Collapsible>${primary}</Collapsible>${primary}`],
  ["a slot's fallback content", `<slot>${primary}</slot>${primary}`],
  ["an omitted prop whose default does not match", `<AppButton>Save</AppButton>${primary}`],
])("stays quiet for %s", async (_name, body) => {
  const result = await limitDiagnostics({
    "app/components/Collapsible.vue": `<template><div><slot v-if="open" /></div></template>`,
    "app/pages/index.vue": page(body),
  });

  expect(result).toEqual([]);
});

test("stays quiet when the page's layout is computed", async () => {
  const result = await limitDiagnostics({
    "app/layouts/default.vue": layout(primary),
    "app/pages/index.vue": page(primary, "definePageMeta({ layout: name })"),
  });

  expect(result).toEqual([]);
});

test("a page that turns its layout off does not count the default layout", async () => {
  const result = await limitDiagnostics({
    "app/layouts/default.vue": layout(primary),
    "app/pages/index.vue": page(primary, "definePageMeta({ layout: false })"),
  });

  expect(result).toEqual([]);
});

test("two pages with one primary each stay quiet", async () => {
  const result = await limitDiagnostics({
    "app/pages/index.vue": page(primary),
    "app/pages/about.vue": page(primary),
  });

  expect(result).toEqual([]);
});

test("a Vue project without routes stays quiet", async () => {
  const result = await runProjectFixture({
    rules: [limitPerView],
    framework: "vue",
    files: {
      "src/components/AppButton.vue": appButton,
      "src/App.vue": page(primary + primary),
    },
  });

  expect(result.diagnostics).toEqual([]);
});

test("a limit whose why repeats its fix, or that misses max, is an invalid contract", async () => {
  const bad = appButton.replace(JSON.stringify(FIX), JSON.stringify(WHY));
  const result = await diagnose({
    "app/components/AppButton.vue": bad,
    "app/pages/index.vue": page(primary + primary),
  });

  expect(result.diagnostics.map((item) => item.code)).toEqual(["DS0009"]);
  expect(result.diagnostics[0]?.why).toContain("repeats `why` as `fix`");
  expect(result.diagnostics[0]?.suggestion).toContain(
    "In `limits[0]`, rewrite `fix` as the change to make at the extra call sites",
  );
  expect(parseContract({ limits: [{ why: WHY, fix: FIX }] })).toEqual({
    problem: expect.stringContaining("`limits[0]` needs `max`"),
    remedy:
      "In `limits[0]`, set `max` to the number of matching usages one view may render, such as `max: 1`.",
  });
  expect(parseContract({ limits: [{ when: { variant: 1 }, max: 1, why: WHY, fix: FIX }] })).toEqual(
    {
      problem: expect.stringContaining("`when.variant`"),
      remedy: expect.stringContaining("`when.variant`"),
    },
  );
  expect(parseContract({ limits: [{ max: 1, why: WHY, fix: FIX }] })).toEqual({
    contract: { replaces: [], limits: [{ when: {}, max: 1, why: WHY, fix: FIX }] },
  });
});

test("a malformed contracts option fails as DOC0020", () => {
  expect(() =>
    limitPerView.validateOptions?.({ contracts: { UButton: { limits: [{ max: "one" }] } } }),
  ).toThrow(/limits\[0\]/);
});

test("a Nuxt UI app wrapped in UApp still counts, as heuristic-high", async () => {
  const result = await limitDiagnostics(
    {
      "app/app.vue": `<template><UApp><NuxtLayout><NuxtPage /></NuxtLayout></UApp></template>`,
      "app/pages/index.vue": page(primary + primary),
    },
    undefined,
    NUXT_UI,
  );

  expect(result).toHaveLength(1);
  expect(result[0]?.confidence).toBe("heuristic-high");
});
