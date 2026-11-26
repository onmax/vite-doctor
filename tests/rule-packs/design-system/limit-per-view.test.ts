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

test.each([
  'class="flex"',
  `:class="'flex'"`,
  `:class="['flex', { hidden: false }]"`,
  ':hidden="false"',
  `v-bind="{ id: 'actions' }"`,
])("counts through a visibly mounted layout with %s", async (attrs) => {
  expect(
    await limitDiagnostics({
      "app/app.vue": `<template><NuxtLayout ${attrs}><NuxtPage /></NuxtLayout></template>`,
      "app/layouts/default.vue": layout(primary),
      "app/pages/index.vue": page(primary),
    }),
  ).toHaveLength(1);
});

test("layout API mentions in text, comments and strings do not disable views", async () => {
  expect(
    await limitDiagnostics({
      "app/pages/index.vue": page(primary + primary),
      "app/pages/docs.vue": page(
        `<p :title="'chooseLayout()'">Call setPageLayout() or use appLayout.</p>`,
        `import { setPageLayout as chooseLayout } from '#imports';
         const docs = "setPageLayout()"; // defineRouteRules({ appLayout: false })`,
      ),
      "nuxt.config.ts": `// Set appLayout in routeRules.\nexport default defineNuxtConfig({})`,
    }),
  ).toHaveLength(1);
});

test("a layout switch in a template handler disables views", async () => {
  expect(
    await limitDiagnostics({
      "app/pages/index.vue": page(primary + primary),
      "app/pages/settings.vue": page(
        `<button @click="setPageLayout('plain')">Change layout</button>`,
      ),
    }),
  ).toEqual([]);
});

test.each([
  [`{{ setPageLayout }}`, `const setPageLayout = 'documentation'`],
  [`{{ examples.setPageLayout }}`, `const examples = { setPageLayout: 'documentation' }`],
  [`<div v-for="setPageLayout in examples">{{ setPageLayout }}</div>`, `const examples = []`],
  [
    `<div v-for="({ setPageLayout = 'label' }) in examples">{{ setPageLayout }}</div>`,
    `const examples = [{}]`,
  ],
  [`{{ nuxt.useNuxtApp().payload }}`, `import * as nuxt from '#imports'`],
])(
  "layout API names used as local template data do not disable views: %s",
  async (body, script) => {
    expect(
      await limitDiagnostics({
        "app/pages/index.vue": page(primary + primary),
        "app/pages/docs.vue": page(body, script),
      }),
    ).toMatchObject([{ data: { routes: ["/"] } }]);
  },
);

test.each([
  `const { useRuntimeConfig: config, ['useNuxtApp']: app } = api; config(); app();`,
  `let config; ({ useRuntimeConfig: config } = api); config();`,
])("known non-layout namespace destructuring preserves views: %s", async (script) => {
  expect(
    await limitDiagnostics({
      "app/layouts/default.vue": layout(primary),
      "app/pages/index.vue": page(primary),
      "app/pages/docs.vue": page("", `import * as api from '#imports'; ${script}`),
    }),
  ).toMatchObject([{ data: { routes: ["/"] } }]);
});

test.each([
  `const { setPageLayout: select } = api; select('plain');`,
  `const key = 'setPageLayout'; const { [key]: select } = api; select('plain');`,
  `const { useRuntimeConfig, ...rest } = api; rest.setPageLayout('plain');`,
  `const { useRuntimeConfig = setPageLayout('plain') } = api;`,
  `let useRuntimeConfig; const alias = ({ useRuntimeConfig } = api); alias.setPageLayout('plain');`,
])("keeps layout uncertainty for namespace destructuring: %s", async (script) => {
  expect(
    await limitDiagnostics({
      "app/layouts/default.vue": layout(primary),
      "app/pages/index.vue": page(primary),
      "app/pages/docs.vue": page("", `import * as api from '#imports'; ${script}`),
    }),
  ).toEqual([]);
});

test.each<Record<string, string>>([
  {
    "app/middleware/select.global.ts": `export default defineNuxtRouteMiddleware(() => {
      const selectLayout = setPageLayout;
      selectLayout('plain');
    });`,
  },
  {
    "app/components/LayoutSelector.vue": page(
      `<button @click="chooseLayout('plain')">Change layout</button>`,
      `import { setPageLayout as chooseLayout } from '#imports'`,
    ),
  },
  {
    "app/components/LayoutSelector.vue": page(
      `<button @click="nuxt['setPageLayout']('plain')">Change layout</button>`,
      `import * as nuxt from '#imports'`,
    ),
  },
  {
    "app/middleware/select.global.ts": `import * as nuxt from '#imports';
      export default defineNuxtRouteMiddleware(() => {
        const api = nuxt;
        api.setPageLayout('plain');
      });`,
  },
  {
    "app/components/LayoutSelector.vue": page(
      `<button @click="select(nuxt)">Change layout</button>`,
      `import * as nuxt from '#imports'; import { select } from '../utils/layout'`,
    ),
    "app/utils/layout.ts": `export const select = api => api.setPageLayout('plain')`,
  },
  {
    "app/pages/settings.vue": page(
      `<div v-for="({ layout = setPageLayout('plain') }) in [{}]">{{ layout }}</div>`,
    ),
  },
  {
    "app/pages/settings.vue": page(
      `<Toolbar v-slot="{ layout = setPageLayout('plain') }">{{ layout }}</Toolbar>`,
    ),
    "app/components/Toolbar.vue": `<template><slot /></template>`,
  },
  {
    "app/pages/settings.vue": page(
      `<div v-if="false"/><div v-else-if="setPageLayout('plain')" v-for="setPageLayout in []"/>`,
    ),
  },
])("layout API references can switch layouts through aliases: %j", async (files) => {
  expect(
    await limitDiagnostics({
      ...files,
      "app/layouts/default.vue": layout(primary),
      "app/layouts/plain.vue": layout(),
      "app/pages/index.vue": page(primary),
    }),
  ).toEqual([]);
});

test.each([
  `<AppButton variant="secondary" :variant="'primary'" />`,
  `<AppButton :variant.prop="'primary'" />`,
  `<AppButton :variant.attr="'primary'" />`,
])("does not match a prop that Vue may not deliver: %s", async (button) => {
  expect(await limitDiagnostics({ "app/pages/index.vue": page(primary + button) })).toEqual([]);
});

test.each([
  `withDefaults(defineProps<{ variant?: string }>(), { variant: 'primary', ...{ variant: 'secondary' } })`,
  `defineProps({ variant: { type: String, default: 'primary', ...{ default: 'secondary' } } })`,
])("does not count an overridden default", async (props) => {
  expect(
    await limitDiagnostics({
      "app/components/AppButton.vue": appButton.replace(/^withDefaults.*;$/m, `${props};`),
      "app/pages/index.vue": page(primary + `<AppButton />`),
    }),
  ).toEqual([]);
});

test("does not count a default declared under a different raw prop key", async () => {
  expect(
    await limitDiagnostics({
      "app/components/AppButton.vue": appButton
        .replace(
          /^withDefaults.*;$/m,
          `withDefaults(defineProps<{ buttonTone?: string }>(), { buttonTone: 'secondary', 'button-tone': 'primary' });`,
        )
        .replace('when: { variant: "primary" }', 'when: { buttonTone: "primary" }'),
      "app/pages/index.vue": page(`<AppButton button-tone="primary" /><AppButton />`),
    }),
  ).toEqual([]);
});

test.each([
  ["{ variant: 'secondary' }", "primary", 0],
  ["{ variant: 'primary' }", "secondary", 1],
  ["{ ...defaults }", "primary", 0],
  ["{}", "primary", 0],
  [undefined, "primary", 1],
])(
  "distinguishes prop defaults from local destructuring fallbacks (%s)",
  async (defaults, local, count) => {
    const props = `defineProps<{ variant?: string }>()`;
    const declaration = defaults ? `withDefaults(${props}, ${defaults})` : props;
    expect(
      await limitDiagnostics({
        "app/components/AppButton.vue": appButton.replace(
          /^withDefaults.*;$/m,
          `${defaults === "{ ...defaults }" ? `import { defaults } from '../defaults';\n` : ""}const { variant = '${local}' } = ${declaration};`,
        ),
        "app/defaults.ts": `export const defaults = { variant: 'secondary' }`,
        "app/pages/index.vue": page(primary + `<AppButton />`),
      }),
    ).toHaveLength(count);
  },
);

test("does not count a statically named slot when its name is also bound", async () => {
  expect(
    await limitDiagnostics({
      "app/components/Toolbar.vue": `<template><div><slot name="default" :name="name" /></div></template>`,
      "app/pages/index.vue": page(primary + `<Toolbar>${primary}</Toolbar>`),
    }),
  ).toEqual([]);
});

test.each([
  `<NuxtPage name="sidebar" />`,
  `<NuxtPage :route="other" />`,
  `<NuxtPage>Replacement</NuxtPage>`,
  `<NuxtPage v-slot="{ Component }"><p>Replacement</p></NuxtPage>`,
])("does not include a page through an overridden router outlet", async (outlet) => {
  expect(
    await limitDiagnostics({
      "app/app.vue": page(primary + outlet),
      "app/pages/index.vue": page(primary),
    }),
  ).toEqual([]);
});

test("the implicit app cannot render a page through a layout without a slot", async () => {
  const result = await runProjectFixture({
    rules: [limitPerView],
    framework: "nuxt",
    files: {
      "app/components/AppButton.vue": appButton,
      "app/layouts/default.vue": page(primary),
      "app/pages/index.vue": page(primary),
    },
  });
  expect(result.diagnostics).toEqual([]);
});

test("a local component does not act as NuxtPage", async () => {
  expect(
    await limitDiagnostics({
      "app/app.vue": page(
        primary + `<NuxtPage />`,
        `import NuxtPage from './components/FakePage.vue'`,
      ),
      "app/components/FakePage.vue": page(""),
      "app/pages/index.vue": page(primary),
    }),
  ).toEqual([]);
});

test("a page-local layout override does not borrow the route layout's slot", async () => {
  expect(
    await limitDiagnostics({
      "app/layouts/default.vue": layout(),
      "app/layouts/plain.vue": page(""),
      "app/pages/index.vue": page(primary + `<NuxtLayout name="plain">${primary}</NuxtLayout>`),
    }),
  ).toEqual([]);
});

test("an overlay component's own content does not count", async () => {
  expect(
    await limitDiagnostics({
      "app/components/ActionsDialog.vue": page(primary),
      "app/pages/index.vue": page(primary + `<ActionsDialog />`),
    }),
  ).toEqual([]);
});

test("uses a literal route override and keeps the page identity", async () => {
  expect(
    await limitDiagnostics({
      "app/pages/index.vue": page(primary + primary, `definePageMeta({ path: '/checkout' })`),
    }),
  ).toMatchObject([{ data: { routes: ["/checkout"], pages: ["app/pages/index.vue"] } }]);
});

test("an explicit local binding does not inherit the registered SFC contract", async () => {
  expect(
    await limitDiagnostics({
      "app/custom-button.ts": `export default { render: () => null }`,
      "app/pages/index.vue": page(primary + primary, `import AppButton from '../custom-button'`),
    }),
  ).toEqual([]);
});

test("counts configured kebab-case names", async () => {
  expect(
    await limitDiagnostics(
      {
        "app/pages/index.vue": page(`<u-button /><u-button />`),
      },
      { contracts: { "u-button": { limits: [{ max: 1, why: WHY, fix: FIX }] } } },
      NUXT_UI,
    ),
  ).toHaveLength(1);
});

test("two unconditional slot outlets produce two inspectable instances", async () => {
  const result = await limitDiagnostics({
    "app/components/Twice.vue": `<template><div><slot />\n<slot /></div></template>`,
    "app/pages/index.vue": page(`<Twice>${primary}</Twice>`),
  });
  expect(result).toHaveLength(1);
  expect(result[0]?.evidence?.map(({ summary }) => summary).join("\n")).toMatch(
    /Twice\.vue:1:.*Twice\.vue:2:/s,
  );
});

test("two reachable NuxtLayout mounts count the layout twice", async () => {
  expect(
    await limitDiagnostics({
      "app/app.vue": page(`<NuxtLayout><NuxtPage /></NuxtLayout><NuxtLayout />`),
      "app/layouts/default.vue": layout(primary),
      "app/pages/index.vue": page(""),
    }),
  ).toHaveLength(1);
});

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

test.each(["buttonTone", "button-tone"])(
  "uses the literal default for a prop declared as %s",
  async (prop) => {
    const component = appButton
      .replace("variant?: string", `${JSON.stringify(prop)}?: string`)
      .replace('variant: "secondary"', `${JSON.stringify(prop)}: "primary"`)
      .replace("when: { variant:", 'when: { "button-tone":')
      .replace(':class="variant"', "");
    expect(
      await limitDiagnostics({
        "app/components/AppButton.vue": component,
        "app/pages/index.vue": page('<AppButton button-tone="primary" /><AppButton />'),
      }),
    ).toHaveLength(1);
  },
);

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

test("a responsive header's desktop and mobile primaries stay quiet", async () => {
  const result = await limitDiagnostics({
    "app/layouts/default.vue": layout(
      `<header><nav class="hidden lg:flex">${primary}</nav><div class="lg:hidden">${primary}</div></header>`,
    ),
    "app/pages/index.vue": page("<p>Home</p>"),
  });

  expect(result).toEqual([]);
});

test.each([
  ["a hidden class on the usage", `<AppButton class="hidden" variant="primary" />`],
  ["an sr-only ancestor", `<div class="sr-only">${primary}</div>`],
  ["a max-sm:hidden ancestor", `<div class="flex max-sm:hidden">${primary}</div>`],
  ["a bound class on an ancestor", `<div :class="{ hidden: compact }">${primary}</div>`],
  ["a bound class on the usage", `<AppButton :class="classes" variant="primary" />`],
  ["a native dialog", `<dialog>${primary}</dialog>`],
  ["a native details", `<details><p>${primary}</p></details>`],
  ["a hidden attribute", `<div hidden>${primary}</div>`],
  ["a popover attribute", `<div popover>${primary}</div>`],
  ["a bound hidden attribute", `<div :hidden="collapsed">${primary}</div>`],
  ["a forced hidden attribute with a false value", `<div :hidden.attr="false">${primary}</div>`],
  [
    "a spread that forces a hidden attribute",
    `<div v-bind="{ '^hidden': false }">${primary}</div>`,
  ],
  ["a spread with hiding styles", `<div v-bind="{ style: { display: 'none' } }">${primary}</div>`],
])("does not count a usage under %s", async (_name, hidden) => {
  const result = await limitDiagnostics({
    "app/pages/index.vue": page(hidden + primary),
  });

  expect(result).toEqual([]);
});

test("a usage under classes that do not hide it still counts", async () => {
  const result = await limitDiagnostics({
    "app/pages/index.vue": page(
      `<div class="flex lg:flex-row hidden-x">${primary}</div>${primary}`,
    ),
  });

  expect(result).toHaveLength(1);
});

test("stays quiet when the app calls setPageLayout", async () => {
  const result = await limitDiagnostics({
    "app/layouts/default.vue": layout(primary),
    "app/layouts/admin.vue": layout(),
    "app/middleware/admin.global.ts": `export default defineNuxtRouteMiddleware((to) => {\n  if (to.path.startsWith("/admin")) setPageLayout("admin");\n});\n`,
    "app/pages/index.vue": page(primary),
  });

  expect(result).toEqual([]);
});

test("stays quiet when nuxt.config sets appLayout in routeRules", async () => {
  const result = await limitDiagnostics({
    "nuxt.config.ts": `export default defineNuxtConfig({ routeRules: { "/**": { appLayout: "admin" } } });\n`,
    "app/layouts/default.vue": layout(primary),
    "app/layouts/admin.vue": layout(),
    "app/pages/index.vue": page(primary),
  });

  expect(result).toEqual([]);
});

test("an appLayout route rule in the manifest silences only the routes it may match", async () => {
  await withFixture(
    {
      "app/app.vue": app,
      "app/components/AppButton.vue": appButton,
      "app/layouts/default.vue": layout(primary),
      "app/layouts/admin.vue": layout(),
      "app/pages/index.vue": page(primary),
      "app/pages/admin/index.vue": page(primary),
      "app/pages/admin/[id].vue": page(primary),
      "nuxt.config.ts": `export default defineNuxtConfig({ routeRules: { "/admin/**": { appLayout: "admin" } } });\n`,
    },
    NUXT_UI,
    async (root) => {
      await writeFileManifest(root, [], {
        generatedAt: new Date(Date.now() + 10_000).toISOString(),
        routeRules: { "/admin/**": { appLayout: "admin" } },
      });
      const result = await runViteDoctor({ root, framework: "nuxt", cache: false });
      expect(result.diagnostics.filter(({ code }) => code === "DS0008")).toMatchObject([
        { data: { routes: ["/"] } },
      ]);
    },
  );
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

const limitGaps = async (...args: Parameters<typeof diagnose>) =>
  ((await diagnose(...args)).project.evidenceGaps ?? []).filter(
    ({ source }) => source === "vite-doctor/design-system",
  );

test("adds no evidence gap when every route has a View", async () => {
  expect(
    await limitGaps({
      "app/layouts/default.vue": layout(primary),
      "app/pages/index.vue": page(primary),
    }),
  ).toEqual([]);
});

test("adds no evidence gap when no contract declares limits", async () => {
  expect(
    await limitGaps({
      "app/components/AppButton.vue": `<template><button><slot /></button></template>`,
      "app/middleware/admin.global.ts": `export default defineNuxtRouteMiddleware(() => setPageLayout("admin"))`,
      "app/pages/index.vue": page(primary, "definePageMeta({ layout: name })"),
    }),
  ).toEqual([]);
});

test.each<[string, Record<string, string>, string[], RegExp]>([
  [
    "a setPageLayout reference",
    {
      "app/middleware/admin.global.ts": `export default defineNuxtRouteMiddleware(() => setPageLayout("admin"))`,
      "app/pages/index.vue": page(primary),
    },
    ["app/middleware/admin.global.ts"],
    /setPageLayout\(\).*did not count component limits on any route.*definePageMeta\(\{ layout \}\)/,
  ],
  [
    "an appLayout route rule Doctor only sees in nuxt.config",
    {
      "nuxt.config.ts": `export default defineNuxtConfig({ routeRules: { "/**": { appLayout: "admin" } } })\n`,
      "app/pages/index.vue": page(primary),
    },
    ["nuxt.config.ts"],
    /appLayout.*did not count component limits on any route.*nuxt prepare.*vite-doctor\/nuxt/,
  ],
  [
    "a page whose own route rules may set appLayout",
    { "app/pages/index.vue": page(primary, `defineRouteRules({ appLayout: "plain" })`) },
    ["app/pages/index.vue"],
    /defineRouteRules.*appLayout.*definePageMeta\(\{ layout \}\)/,
  ],
  [
    "computed layouts, once for every page",
    {
      "app/pages/index.vue": page(primary, "definePageMeta({ layout: name })"),
      "app/pages/about.vue": page(primary, "definePageMeta({ layout: name })"),
    },
    ["app/pages/about.vue", "app/pages/index.vue"],
    /layout Doctor cannot read.*string literal or false/,
  ],
  [
    "a layout app.vue picks with name",
    {
      "app/app.vue": `<template><NuxtLayout :name="layout"><NuxtPage /></NuxtLayout></template>`,
      "app/pages/index.vue": page(primary),
    },
    ["app/app.vue"],
    /name.*fallback.*<NuxtLayout>.*did not count component limits on any route/,
  ],
  [
    "layers Doctor cannot read without a manifest",
    { "nuxt.config.ts": `export default defineNuxtConfig({ extends: ["docus"] })\n` },
    ["nuxt.config.ts"],
    /extends layers.*did not count component limits on any route.*nuxt prepare.*vite-doctor\/nuxt/,
  ],
  [
    "custom pages configuration",
    { "nuxt.config.ts": `export default defineNuxtConfig({ dir: { pages: "routes" } })\n` },
    ["nuxt.config.ts"],
    /cannot list the routes.*nuxt prepare.*vite-doctor\/nuxt/,
  ],
  [
    "an app component chosen by a hook",
    {
      "nuxt.config.ts": `export default defineNuxtConfig({ hooks: { "app:resolve"(app) {} } })\n`,
    },
    ["nuxt.config.ts"],
    /which app component.*nuxt prepare.*vite-doctor\/nuxt/,
  ],
  [
    "a router outlet Doctor cannot verify",
    {
      "app/app.vue": page(`<NuxtPage name="sidebar" />`),
      "app/pages/index.vue": page(primary + primary),
    },
    ["app/app.vue"],
    /cannot verify that app\/app.vue renders.*<NuxtPage \/>/,
  ],
])("names the cause when %s leaves routes without a View", async (_, files, gapFiles, message) => {
  const gaps = await limitGaps({ "app/layouts/default.vue": layout(), ...files });
  expect(gaps).toEqual([
    {
      source: "vite-doctor/design-system",
      message: expect.stringMatching(message),
      files: gapFiles,
    },
  ]);
  expect(gaps[0]!.message).toMatch(/^.*DS0008/);
});

test("an appLayout route rule in the manifest names the routes it left out", async () => {
  await withFixture(
    {
      "app/app.vue": app,
      "app/components/AppButton.vue": appButton,
      "app/layouts/default.vue": layout(primary),
      "app/pages/index.vue": page(primary),
      "app/pages/admin/index.vue": page(primary),
      "app/pages/admin/[id].vue": page(primary),
      "nuxt.config.ts": `export default defineNuxtConfig({ routeRules: { "/admin/**": { appLayout: "admin" } } });\n`,
    },
    NUXT_UI,
    async (root) => {
      await writeFileManifest(root, [], {
        generatedAt: new Date(Date.now() + 10_000).toISOString(),
        routeRules: { "/admin/**": { appLayout: "admin" } },
      });
      const result = await runViteDoctor({ root, framework: "nuxt", cache: false });
      expect(
        result.project.evidenceGaps?.filter(({ source }) => source === "vite-doctor/design-system"),
      ).toEqual([
        {
          source: "vite-doctor/design-system",
          message: expect.stringMatching(/appLayout route rules \/admin\/\*\*.*2 routes/),
          files: ["app/pages/admin/[id].vue", "app/pages/admin/index.vue"],
        },
      ]);
    },
  );
});
