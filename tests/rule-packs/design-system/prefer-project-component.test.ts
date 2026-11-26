import { expect, test } from "vite-plus/test";
import { nuxtAppInputSignature } from "../../../src/core/internal/nuxt-app-inputs.ts";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import { explainRule } from "../../../src/core/reports.ts";
import { runViteDoctor } from "../../../src/doctor.ts";
import {
  preferProjectComponent,
  unreadableContract,
} from "../../../src/rule-packs/design-system/index.ts";
import { nuxtUiRulePack } from "../../../src/rule-packs/nuxt/rules/nuxt-ui.ts";
import { getDiagnosticDocuments } from "../../../docs/rules/source.ts";
import nuxtDoctorModule from "../../../src/rule-packs/nuxt/module.ts";
import { withFixture, writeFileManifest } from "../nuxt/nuxt-modern-rules-fixture.ts";

const NUXT_UI = { "@nuxt/ui": "^4.0.0" };

const diagnose = (
  files: Record<string, string>,
  options: {
    framework?: "nuxt" | "vue";
    dependencies?: Record<string, string>;
    config?: object;
  } = {},
) =>
  runProjectFixture({
    rules: [preferProjectComponent, unreadableContract],
    framework: options.framework ?? "vue",
    dependencies: options.dependencies,
    ...(options.config && {
      config: { rules: { "design-system/prefer-project-component": ["info", options.config] } },
    }),
    files,
  });

test("a plain <button> in a Nuxt UI app reports DS0007 naming UButton", async () => {
  const result = await diagnose(
    {
      "app/pages/index.vue": `<template><button type="button" @click="copy()">Copy</button></template>`,
    },
    { framework: "nuxt", dependencies: NUXT_UI },
  );

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({
    ruleId: "design-system/prefer-project-component",
    code: "DS0007",
    file: expect.stringContaining("app/pages/index.vue"),
    confidence: "heuristic-high",
  });
  expect(result.diagnostics[0]?.message).toContain("UButton");
  expect(result.diagnostics[0]?.suggestion).toContain("<UButton>");
  expect(result.diagnostics[0]?.suggestion).toContain("color, variant, size, and icon");
});

test("Nuxt UI form controls map to UInput, UTextarea and USelect", async () => {
  const result = await diagnose(
    {
      "app/pages/index.vue": `<template>
<input type="email" v-model="email">
<textarea v-model="body" />
<select v-model="value"><option value="a">A</option></select>
</template>`,
    },
    { framework: "nuxt", dependencies: NUXT_UI },
  );

  expect(result.diagnostics.map((item) => [item.code, item.range?.line])).toEqual([
    ["DS0007", 2],
    ["DS0007", 3],
    ["DS0007", 4],
  ]);
  expect(result.diagnostics.map((item) => item.suggestion)).toEqual([
    expect.stringContaining("<UInput>"),
    expect.stringContaining("<UTextarea>"),
    expect.stringContaining("<USelect>"),
  ]);
  expect(result.diagnostics[0]?.message).toContain("UFormField");
});

test("Nuxt UI ignores UButton, explicit doctor ignores, and apps without Nuxt UI", async () => {
  const files = {
    "app/pages/index.vue": `<template>
<UButton @click="copy()">Copy</UButton>
<button data-doctor-ignore type="button">Native</button>
<button :data-doctor-ignore="true">Bound</button>
<component :is="tag">Dynamic</component>
<button :is="tag">Customized</button>
</template>`,
  };
  expect((await diagnose(files, { framework: "nuxt", dependencies: NUXT_UI })).diagnostics).toEqual(
    [],
  );
  const plain = await diagnose(
    { "app/pages/index.vue": `<template><button>Copy</button></template>` },
    { framework: "nuxt" },
  );
  expect(plain.diagnostics).toEqual([]);
});

test("an empty <button> used as a hit area reports nothing", async () => {
  const result = await diagnose(
    {
      "app/pages/index.vue": `<template>
<UTooltip v-for="bar in bars" :key="bar.id" :text="bar.label">
  <button class="h-full w-full" :aria-label="bar.label" />
</UTooltip>
<button type="button" :aria-label="label"><!-- icon --> </button>
<button type="button" v-text="label" />
</template>`,
    },
    { framework: "nuxt", dependencies: NUXT_UI },
  );
  expect(result.diagnostics.map((d) => d.range?.line)).toEqual([6]);
});

test("ambiguous native inputs and non-text inputs report nothing", async () => {
  const result = await diagnose(
    {
      "app/pages/index.vue": `<template>
<div>
  <form>
    <label>Email</label>
    <input type="checkbox">
    <input type="file">
    <input type="hidden">
    <input :type="dynamicType">
    <input ref="input" v-bind="attachments.inputProps.value" class="sr-only">
    <input type="text" v-bind="inputAttrs">
    <input v-bind="inputAttrs" type="text">
  </form>
</div>
</template>`,
    },
    { framework: "nuxt", dependencies: NUXT_UI },
  );

  // Only the input whose static type follows the spread is known to be text.
  expect(result.diagnostics.map((item) => [item.range?.line, item.suggestion])).toEqual([
    [11, expect.stringContaining("<UInput>")],
  ]);
});

test("a declared AppButton contract reports DS0007 naming AppButton", async () => {
  const result = await diagnose(
    {
      "src/components/AppButton.vue": `<script setup lang="ts">
defineOptions({ doctor: { replaces: "button" } });
</script>

<template>
  <button class="app-button"><slot /></button>
</template>`,
      "src/App.vue": `<script setup lang="ts">
import AppButton from "./components/AppButton.vue";
</script>

<template>
  <AppButton>Save</AppButton>
  <button type="button">Cancel</button>
</template>`,
    },
    { dependencies: NUXT_UI },
  );

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({
    code: "DS0007",
    file: expect.stringContaining("src/App.vue"),
    confidence: "proven",
    range: expect.objectContaining({ line: 7 }),
  });
  expect(result.diagnostics[0]?.message).toContain("AppButton declares that it replaces <button>");
  expect(result.diagnostics[0]?.suggestion).toContain("Replace <button> with <AppButton>");
});

test("an array contract replaces every listed element", async () => {
  const result = await diagnose({
    "src/components/AppField.vue": `<script setup lang="ts">
defineOptions({ doctor: { replaces: ["input", "textarea"] } as const });
</script>

<template>
  <label><slot /><input class="app-field"></label>
</template>`,
    "src/App.vue": `<script setup lang="ts">
import AppField from "./components/AppField.vue";
</script>

<template>
  <AppField />
  <input v-model="name">
  <textarea v-model="bio" />
</template>`,
  });

  expect(result.diagnostics.map((item) => [item.file?.split("/").pop(), item.range?.line])).toEqual(
    [
      ["App.vue", 7],
      ["App.vue", 8],
    ],
  );
  expect(result.diagnostics.every((item) => item.suggestion?.includes("<AppField>"))).toBe(true);
});

test("rule options declare contracts for components the project does not own", async () => {
  const result = await diagnose(
    { "src/App.vue": `<template><a href="/docs">Docs</a></template>` },
    { config: { contracts: { ULink: { replaces: "a" } } } },
  );

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({ code: "DS0007", confidence: "proven" });
  expect(result.diagnostics[0]?.suggestion).toContain("Replace <a> with <ULink>");
});

test.each([
  `<script setup>import { RouterLink } from 'vue-router'</script>`,
  `<script>import { RouterLink } from 'vue-router'; export default { components: { RouterLink } }</script>`,
])("configured contracts work with locally bound external components (%s)", async (script) => {
  const result = await diagnose(
    { "src/App.vue": `${script}<template><a href="/docs">Docs</a></template>` },
    { config: { contracts: { RouterLink: { replaces: "a" } } } },
  );
  expect(result.diagnostics.map(({ suggestion }) => suggestion)).toEqual([
    expect.stringContaining("Replace <a> with <RouterLink>"),
  ]);
});

test("malformed contracts options fail with DOC0020", async () => {
  await expect(
    diagnose(
      { "src/App.vue": `<template><a href="/docs">Docs</a></template>` },
      { config: { contracts: { ULink: { replaces: "A tag" } } } },
    ),
  ).rejects.toThrow(/contracts\.ULink/);
});

test("a declared contract outranks the Nuxt UI table", async () => {
  const result = await diagnose(
    {
      "app/components/AppButton.vue": `<script setup lang="ts">
defineOptions({ doctor: { replaces: "button" } });
</script>

<template>
  <UButton><slot /></UButton>
</template>`,
      "app/pages/index.vue": `<template><button>Save</button></template>`,
    },
    { framework: "nuxt", dependencies: NUXT_UI },
  );

  expect(result.diagnostics.map((item) => item.suggestion)).toEqual([
    expect.stringContaining("<AppButton>"),
  ]);
});

test("shadcn-vue components/ui/button/Button.vue is inferred", async () => {
  const result = await diagnose({
    "src/components/ui/button/Button.vue": `<template>
  <Primitive :as="as" :class="cn(buttonVariants({ variant, size }), props.class)">
    <slot />
  </Primitive>
</template>`,
    "src/components/ui/button/index.ts": `export { default as Button } from "./Button.vue";\n`,
    "src/App.vue": `<script setup lang="ts">
import { Button } from "./components/ui/button";
</script>

<template>
  <Button>Save</Button>
  <button type="button">Cancel</button>
</template>`,
  });

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({
    code: "DS0007",
    file: expect.stringContaining("src/App.vue"),
    confidence: "heuristic-high",
  });
  expect(result.diagnostics[0]?.suggestion).toContain("Replace <button> with <Button>");
  expect(result.diagnostics[0]?.message).toContain("src/components/ui/button/Button.vue");
});

test("a Button.vue outside components/ui is inferred only when its single root is a <button>", async () => {
  const wrapper = await diagnose({
    "src/components/Button.vue": `<template>\n  <button class="btn"><slot /></button>\n</template>`,
    "src/App.vue": `<template><button>Save</button></template>`,
  });
  expect(wrapper.diagnostics.map((item) => item.suggestion)).toEqual([
    expect.stringContaining("<Button>"),
  ]);

  const conditional = await diagnose({
    "src/components/Button.vue": `<template>\n  <button v-if="ok" class="btn"><slot /></button>\n</template>`,
    "src/App.vue": `<template><button>Save</button></template>`,
  });
  expect(conditional.diagnostics).toEqual([]);
});

test("two candidates for one element report nothing", async () => {
  const contract = (name: string) =>
    `<script setup lang="ts">
defineOptions({ doctor: { replaces: "button" } });
</script>

<template>
  <button class="${name}"><slot /></button>
</template>`;
  const result = await diagnose({
    "src/components/AppButton.vue": contract("app"),
    "src/components/BrandButton.vue": contract("brand"),
    "src/App.vue": `<template><button>Save</button></template>`,
  });

  expect(result.diagnostics).toEqual([]);
});

const brandButton = `<script setup lang="ts">
defineOptions({ doctor: { replaces: "button" } });
</script>
<template><div><button><slot /></button></div></template>`;

const rawButton = `<template><button>Save</button></template>`;

test("distinct contracts with the same component name remain ambiguous", async () => {
  const result = await diagnose({
    "src/one/BrandButton.vue": brandButton,
    "src/two/BrandButton.vue": brandButton,
    "src/App.vue": rawButton,
  });
  expect(result.diagnostics).toEqual([]);
});

test("uses a call-site import alias but neither leaks it nor recommends a shadowed name", async () => {
  const result = await diagnose({
    "src/BrandButton.vue": brandButton,
    "src/Other.vue": `<template><span /></template>`,
    "src/Alias.vue": `<script setup>import Action from './BrandButton.vue'</script>
<template><div><Action /><button>Go</button></div></template>`,
    "src/Lowercase.vue": `<script setup>import action from './BrandButton.vue'; import Action from './Other.vue'</script>${rawButton}`,
    "src/Unrelated.vue": `<script setup>import Action from './Other.vue'</script>${rawButton}`,
    "src/Shadowed.vue": `<script setup>import BrandButton from './Other.vue'</script>${rawButton}`,
  });
  expect(result.diagnostics.map((item) => [item.file.split("/").pop(), item.suggestion])).toEqual([
    ["Alias.vue", expect.stringContaining("<Action>")],
    ["Lowercase.vue", expect.stringContaining("<action>")],
    ["Unrelated.vue", expect.stringContaining("<BrandButton>")],
  ]);
});

test("workspace apps only see their own contracts or explicitly imported components", async () => {
  const result = await diagnose({
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
    "apps/a/package.json": JSON.stringify({ name: "app-a", dependencies: { vue: "^3.5.0" } }),
    "apps/b/package.json": JSON.stringify({ name: "app-b", dependencies: { vue: "^3.5.0" } }),
    "apps/a/BrandButton.vue": brandButton,
    "apps/a/App.vue": rawButton,
    "apps/b/App.vue": rawButton,
    "apps/b/Imported.vue": `<script setup>import Action from '../a/BrandButton.vue'</script>${rawButton}`,
  });
  expect(
    result.diagnostics.map((item) => [item.file.split("/").slice(-2).join("/"), item.suggestion]),
  ).toEqual([
    ["a/App.vue", expect.stringContaining("<BrandButton>")],
    ["b/Imported.vue", expect.stringContaining("<Action>")],
  ]);
});

test("Nuxt UI module evidence does not cross into another workspace app", async () => {
  const result = await diagnose(
    {
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
      "apps/a/package.json": JSON.stringify({
        name: "app-a",
        dependencies: { nuxt: "^4.0.0", ...NUXT_UI },
      }),
      "apps/a/nuxt.config.ts": `export default defineNuxtConfig({ modules: ['@nuxt/ui'], ui: { prefix: 'Ui' } })`,
      "apps/a/app/pages/index.vue": rawButton,
      "apps/b/package.json": JSON.stringify({ name: "app-b", dependencies: { vue: "^3.5.0" } }),
      "apps/b/App.vue": rawButton,
    },
    { framework: "nuxt" },
  );
  expect(result.diagnostics.map((item) => [item.file.split("/").pop(), item.suggestion])).toEqual([
    ["index.vue", expect.stringContaining("<UiButton>")],
  ]);
});

test("a Nuxt app does not take its Nuxt UI prefix from another workspace app", async () => {
  const result = await diagnose(
    {
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['@nuxt/ui'] })",
      "app/pages/index.vue": rawButton,
      "apps/other/package.json": JSON.stringify({ dependencies: { nuxt: "^4.0.0", ...NUXT_UI } }),
      "apps/other/nuxt.config.ts":
        "export default defineNuxtConfig({ modules: ['@nuxt/ui'], ui: { prefix: 'Other' } })",
      "apps/other/app/pages/about.vue": rawButton,
    },
    { framework: "nuxt", dependencies: NUXT_UI },
  );
  expect(result.diagnostics.map(({ suggestion }) => suggestion)).toEqual([
    expect.stringContaining("<UButton>"),
    expect.stringContaining("<OtherButton>"),
  ]);
});

test("uses Nuxt UI registration provenance, not the UButton spelling", async () => {
  const result = await diagnose(
    {
      "app/pages/index.vue": rawButton,
      "app/components/UButton.vue": `<template><div><button>Go</button></div></template>`,
      ".nuxt/doctor.manifest.json": JSON.stringify({
        components: [
          { name: "UButton", file: "app/components/UButton.vue" },
          { name: "UiButton", file: "node_modules/@nuxt/ui/dist/runtime/components/Button.vue" },
        ],
      }),
    },
    { framework: "nuxt", dependencies: NUXT_UI },
  );
  expect(result.diagnostics.map((item) => item.suggestion)).toEqual([
    expect.stringContaining("<UiButton>"),
    expect.stringContaining("<UiButton>"),
  ]);
});

test("ignores Nuxt component directory configuration when resolved registrations go stale", async () => {
  const result = await diagnose(
    {
      "app/pages/index.vue": rawButton,
      "app/components/New.vue": `<template><span /></template>`,
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: new Date(Date.now() + 10_000).toISOString(),
        components: [{ path: "app/components", pattern: "**/*.vue", prefix: "" }],
        appRegistrationIgnore: { patterns: [], layerRoots: [], fileHash: null },
        appRegistration: {
          components: {
            files: [],
            directories: [{ path: "app/components", patterns: ["**/*.vue"], entries: [] }],
          },
        },
        resolvedComponents: [
          { name: "OldButton", file: "node_modules/@nuxt/ui/dist/runtime/components/Button.vue" },
        ],
      }),
    },
    { framework: "nuxt", dependencies: NUXT_UI },
  );
  expect(result.diagnostics).toMatchObject([
    {
      code: "DS0007",
      suggestion: expect.stringContaining("<UButton>"),
      confidence: "heuristic-high",
    },
  ]);
});

test("a Vue wrapper in a nested pages directory keeps its native root", async () => {
  const result = await diagnose({
    "src/BrandButton.vue": brandButton,
    "src/components/pages/LikeButton.vue": rawButton,
    "src/App.vue": `<script setup>import LikeButton from './components/pages/LikeButton.vue'</script>
<template><div><LikeButton /><button>Go</button></div></template>`,
  });
  expect(result.diagnostics.map(({ file }) => file.split("/").pop())).toEqual(["App.vue"]);
});

test.each([
  { base: "app", pages: "pages", config: "{}" },
  { base: "web", pages: "routes", config: "{ srcDir: 'web', dir: { pages: 'routes' } }" },
])(
  "Options API wrapper roots are exempt but Nuxt page roots in $base/$pages report",
  async ({ base, pages, config }) => {
    const register = (name: string, file: string) =>
      `<script>import ${name} from '${file}'; export default { components: { ${name} } }</script>`;
    const result = await diagnose(
      {
        "nuxt.config.ts": `export default defineNuxtConfig(${config})`,
        [`${base}/App.vue`]: `${register("LikeButton", "./LikeButton.vue")}
<template><LikeButton /></template>`,
        [`${base}/Preview.vue`]: `${register("Home", `./${pages}/index.vue`)}<template><Home /></template>`,
        [`${base}/LikeButton.vue`]: rawButton,
        [`${base}/${pages}/index.vue`]: rawButton,
      },
      { framework: "nuxt", dependencies: NUXT_UI },
    );
    expect(result.diagnostics.map((item) => item.file.split("/").pop())).toEqual(["index.vue"]);
  },
);

test.each(["as const", "satisfies Record<string, unknown>"])(
  "reads options wrapped in %s",
  async (suffix) => {
    const result = await diagnose({
      "src/BrandButton.vue": brandButton.replace(" });", ` } ${suffix});`),
      "src/App.vue": rawButton,
    });
    expect(result.diagnostics.map((item) => item.code)).toEqual(["DS0007"]);
  },
);

test("reports a later unknown spread only when an explicit contract may be overwritten", async () => {
  const imported = `import options from './options';`;
  const result = await diagnose({
    "src/options.ts": `export default { name: 'Button' }`,
    "src/BrandButton.vue": brandButton
      .replace("defineOptions", `${imported}\ndefineOptions`)
      .replace('"button" }', '"button" },\n  ...options'),
    "src/Unrelated.vue": `<script setup>${imported}\ndefineOptions({ ...options })</script>`,
    "src/App.vue": rawButton,
  });
  expect(result.diagnostics).toEqual([
    expect.objectContaining({ code: "DS0009", range: expect.objectContaining({ line: 4 }) }),
  ]);
});

test("LikeButton.vue whose root is a <button> reports nothing inside itself", async () => {
  const result = await diagnose(
    {
      "app/components/LikeButton.vue": `<template>
  <button type="button" class="like" @click="toggle"><slot /></button>
</template>`,
      "app/components/ui/Toolbar.vue": `<template><div><button>Bold</button></div></template>`,
    },
    { framework: "nuxt", dependencies: NUXT_UI },
  );

  expect(result.diagnostics).toEqual([]);
});

test("the replacing component's own file is exempt", async () => {
  const result = await diagnose({
    "src/components/AppButton.vue": `<script setup lang="ts">
defineOptions({ doctor: { replaces: "button" } });
</script>

<template>
  <div class="group">
    <button class="app-button"><slot /></button>
  </div>
</template>`,
  });

  expect(result.diagnostics).toEqual([]);
});

test("a non-literal contract reports DS0009 and no DS0007", async () => {
  const result = await diagnose({
    "src/components/AppButton.vue": `<script setup lang="ts">
const element = "button";
defineOptions({ doctor: { replaces: element } });
</script>

<template>
  <button class="app-button"><slot /></button>
</template>`,
    "src/App.vue": `<template><button>Save</button></template>`,
  });

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({
    ruleId: "design-system/unreadable-contract",
    code: "DS0009",
    file: expect.stringContaining("src/components/AppButton.vue"),
    range: expect.objectContaining({ line: 3 }),
  });
  expect(result.diagnostics[0]?.message).toContain("computed at runtime");
});

test("a contract with an unknown key reports DS0009", async () => {
  const result = await diagnose({
    "src/components/AppButton.vue": `<script setup lang="ts">
defineOptions({ doctor: { replace: "button" } });
</script>

<template>
  <button class="app-button"><slot /></button>
</template>`,
  });

  expect(result.diagnostics.map((item) => item.code)).toEqual(["DS0009"]);
  expect(result.diagnostics[0]?.message).toContain("`replace`");
});

test("NUXT0013 and NUXT0014 are retired", () => {
  expect(nuxtUiRulePack.rules.map((rule) => rule.meta.id)).toEqual(["nuxt-ui/require-uapp-root"]);
  for (const code of ["NUXT0013", "NUXT0014"]) {
    expect(explainRule([nuxtUiRulePack], code, "json")).toBe("");
    expect(getDiagnosticDocuments().map((document) => document.code)).not.toContain(code);
  }
});

test("the Nuxt module adds the Component Contract types to the app", async () => {
  await withFixture({}, {}, async (root) => {
    const hooks = new Map<string, (payload?: any) => unknown>();
    const nuxt = {
      _version: "4.5.1",
      options: { rootDir: root, srcDir: "app", buildDir: ".nuxt", modules: [] },
      hook: (name: string, callback: (payload?: any) => unknown) => hooks.set(name, callback),
      async callHook() {},
    };
    await nuxtDoctorModule({}, nuxt as any);
    const references: Array<{ types: string }> = [];
    await hooks.get("prepare:types")!({ references });
    expect(references).toEqual([{ types: "vite-doctor/component-contract" }]);
  });
});

test("Options API contracts are read from export default and defineComponent", async () => {
  for (const options of [
    `export default { doctor: { replaces: "button" } };`,
    `import { defineComponent } from "vue";\nexport default defineComponent({ doctor: { replaces: "button" } } as const);`,
  ]) {
    const result = await diagnose({
      "src/components/AppButton.vue": `<script lang="ts">
${options}
</script>

<template>
  <button class="app-button"><slot /></button>
</template>`,
      "src/App.vue": rawButton,
    });
    expect(result.diagnostics.map((item) => [item.code, item.suggestion])).toEqual([
      ["DS0007", expect.stringContaining("<AppButton>")],
    ]);
  }
});

test("DS0009 names a later spread as the cause and says where to move it", async () => {
  const result = await diagnose({
    "src/options.ts": `export default { name: "Button" };\n`,
    "src/BrandButton.vue": `<script setup lang="ts">
import options from "./options";
defineOptions({ doctor: { replaces: "button" }, ...options });
</script>
<template><button><slot /></button></template>`,
  });

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.message).toContain("spread or computed key");
  expect(result.diagnostics[0]?.suggestion).toContain("before `doctor`");
});

test.each([
  ["{ replaces: 'Button' }", "Set `replaces` to the lowercase HTML tag"],
  ["{ replace: 'button' }", "correct the spelling using the supported keys: replaces"],
])("DS0009 suggests a validation-specific fix for %s", async (value, remedy) => {
  const result = await diagnose({
    "src/BrandButton.vue": `<script setup>defineOptions({ doctor: ${value} })</script>`,
  });
  expect(result.diagnostics).toMatchObject([
    { code: "DS0009", suggestion: expect.stringContaining(remedy) },
  ]);
});

test.each(["shared", "{ ...shared }"])(
  "DS0009 explains a cross-script override by %s",
  async (arg) => {
    const normal = `<script>export default { doctor: { replaces: 'button' } }</script>`;
    const source = (options: string) => `${normal}
<script setup>import shared from './options'; defineOptions(${options})</script>
<template><button><slot /></button></template>`;
    const files = {
      "src/options.ts": `export default { name: 'Button' }`,
      "src/BrandButton.vue": source(arg),
      "src/App.vue": rawButton,
    };
    const result = await diagnose(files);
    expect(result.diagnostics).toMatchObject([
      {
        code: "DS0009",
        message: expect.stringContaining("override the normal script"),
        suggestion: expect.stringContaining(
          "Put the literal `doctor` option last in `defineOptions`",
        ),
      },
    ]);
    const repaired = await diagnose({
      ...files,
      "src/BrandButton.vue": source("{ ...shared, doctor: { replaces: 'button' } }"),
    });
    expect(repaired.diagnostics.map(({ code }) => code)).toEqual(["DS0007"]);
  },
);

test.each(["current empty", "stale"])(
  "wrapper roots use %s route evidence correctly",
  async (state) => {
    const current = state === "current empty";
    const folder = current ? "pages" : "components";
    await withFixture(
      {
        "nuxt.config.ts": `export default defineNuxtConfig({ modules: ['@nuxt/ui'] })`,
        [`app/${folder}/LikeButton.vue`]: rawButton,
        "app/app.vue": `<script setup>import LikeButton from './${folder}/LikeButton.vue'</script>
<template><div><LikeButton /><button>Save</button></div></template>`,
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
          pages: current ? [] : [{ path: "/old", file: `app/${folder}/LikeButton.vue` }],
          resolvedApp: {
            pagesResolved: true,
            inputs: {
              pages: {
                ...inputs,
                signature: current ? nuxtAppInputSignature(root, inputs) : "stale",
              },
            },
          },
        });
        const result = await runViteDoctor({ root, framework: "nuxt", cache: false });
        expect(result.diagnostics.filter(({ code }) => code === "DS0007")).toMatchObject([
          { file: expect.stringContaining("app/app.vue") },
        ]);
      },
    );
  },
);

test.each([
  ["{ enabled: true }", true],
  ["{ pattern: ['**/*.vue'] }", true],
  ["{ enabled: true, pattern: ['**/*.vue', '!LikeButton.vue'] }", false],
  ["{ pattern: 'index.vue' }", false],
  ["{ enabled: false }", false],
  ["{ enabled: process.env.PAGES }", false],
  ["{ pattern: ['**/*.vue', ...extraPatterns] }", false],
])("uses static object-form pages config %s before prepare", async (pages, isPage) => {
  const result = await diagnose(
    {
      "nuxt.config.ts": `export default defineNuxtConfig({ modules: ['@nuxt/ui'], pages: ${pages} })`,
      "app/pages/LikeButton.vue": rawButton,
      "app/app.vue": `<script setup>import LikeButton from './pages/LikeButton.vue'</script>
<template><LikeButton /></template>`,
    },
    { framework: "nuxt", dependencies: NUXT_UI },
  );
  expect(result.diagnostics).toMatchObject(
    isPage ? [{ code: "DS0007", file: expect.stringContaining("app/pages/LikeButton.vue") }] : [],
  );
});

test.each([
  [".nuxtignore", "**/LikeButton.vue", ""],
  ["unused.txt", "", ", ignore: ['**/LikeButton.vue']"],
  [".nuxtrc", "ignore[]=**/LikeButton.vue", ""],
])(
  "preserves the wrapper exemption with unprepared Nuxt ignore input %s",
  async (file, text, config) => {
    const result = await diagnose(
      {
        [file]: text,
        "nuxt.config.ts": `export default defineNuxtConfig({ modules: ['@nuxt/ui'], pages: { pattern: ['**/*.vue'] }${config} })`,
        "app/pages/LikeButton.vue": rawButton,
        "app/pages/index.vue": rawButton,
        "app/app.vue": `<script setup>import LikeButton from './pages/LikeButton.vue'</script>
<template><LikeButton /></template>`,
      },
      { framework: "nuxt", dependencies: NUXT_UI },
    );
    expect(result.diagnostics).toMatchObject([
      { code: "DS0007", file: expect.stringContaining("app/pages/index.vue") },
    ]);
  },
);

const telemetryRc = "telemetry.enabled=false\ntelemetry.consent=0\n";

test("telemetry settings do not hide an imported Nuxt page's contract diagnostic", async () => {
  const result = await diagnose(
    {
      ".nuxtrc": telemetryRc,
      "nuxt.config.ts": `export default defineNuxtConfig({ pages: { enabled: true, pattern: ['**/*.vue'] } })`,
      "app/components/LocalButton.vue": brandButton,
      "app/pages/LikeButton.vue": rawButton,
      "app/app.vue": `<script setup>import LikeButton from './pages/LikeButton.vue'</script>
<template><LikeButton /></template>`,
    },
    { framework: "nuxt" },
  );
  expect(result.diagnostics).toMatchObject([
    {
      code: "DS0007",
      file: expect.stringContaining("app/pages/LikeButton.vue"),
      suggestion: expect.stringContaining("<LocalButton>"),
      confidence: "proven",
    },
  ]);
});

test.each([
  [telemetryRc, "{ prefix: 'Brand' }", "BrandButton"],
  ["ui.prefix=Other\n", "{ prefix: 'Brand' }", "BrandButton"],
  ["ui.colors.primary=blue\n", "{}", "UButton"],
  ["ui.prefix=Other\n", "{}", undefined],
  ['ui={"prefix":"Other"}\n', "{}", undefined],
])("uses only relevant .nuxtrc evidence for ui: %s / %s", async (rc, ui, name) => {
  const result = await diagnose(
    {
      ".nuxtrc": rc,
      "nuxt.config.ts": `export default defineNuxtConfig({ modules: ['@nuxt/ui'], ui: ${ui} })`,
      "app/pages/index.vue": rawButton,
    },
    { framework: "nuxt", dependencies: NUXT_UI },
  );
  expect(result.diagnostics).toMatchObject(
    name ? [{ code: "DS0007", suggestion: expect.stringContaining(`<${name}>`) }] : [],
  );
});

test.each([
  [
    "conflicting layers",
    {
      "layers/brand/nuxt.config.ts": `export default defineNuxtConfig({ ui: { prefix: 'Brand' } })`,
      "layers/brand-admin/nuxt.config.ts": `export default defineNuxtConfig({ ui: { prefix: 'Admin' } })`,
    },
    ["brand", "brand-admin"],
  ],
  [
    "alternate layer config",
    {
      "layers/brand/.config/nuxt.ts": `export default defineNuxtConfig({ ui: { prefix: 'Brand' } })`,
    },
    ["brand"],
  ],
] as const)(
  "uses registration instead of guessing a Nuxt UI prefix with %s",
  async (_case, files, layers) => {
    await withFixture(
      {
        "nuxt.config.ts": `export default defineNuxtConfig({ modules: ['@nuxt/ui'] })`,
        ...files,
        "app/pages/index.vue": rawButton,
      },
      NUXT_UI,
      async (root) => {
        const run = () => runViteDoctor({ root, framework: "nuxt", cache: false });
        expect((await run()).diagnostics.filter(({ code }) => code === "DS0007")).toEqual([]);
        await writeFileManifest(root, [], {
          generatedAt: new Date(Date.now() + 10_000).toISOString(),
          autoRegisteredLayers: [...layers],
          appRegistrationIgnore: { patterns: [], layerRoots: [], fileHash: null },
          appRegistration: { components: { files: [], directories: [] } },
          resolvedComponents: [
            {
              name: "BrandButton",
              file: "node_modules/@nuxt/ui/dist/runtime/components/Button.vue",
            },
          ],
        });
        expect((await run()).diagnostics.filter(({ code }) => code === "DS0007")).toMatchObject([
          { suggestion: expect.stringContaining("<BrandButton>"), confidence: "manifest-backed" },
        ]);
      },
    );
  },
);

test.each([
  ["layers/.preview", "{}", "UButton"],
  ["layers/brand", "{}", "BrandButton"],
  ["layers/brand", "{ prefix: 'App' }", "AppButton"],
])("uses a known Nuxt UI prefix with %s and app ui: %s", async (layer, ui, name) => {
  const result = await diagnose(
    {
      "nuxt.config.ts": `export default defineNuxtConfig({ modules: ['@nuxt/ui'], ui: ${ui} })`,
      [`${layer}/nuxt.config.ts`]: `export default defineNuxtConfig({ ui: { prefix: 'Brand' } })`,
      "app/pages/index.vue": rawButton,
    },
    { framework: "nuxt", dependencies: NUXT_UI },
  );
  expect(result.diagnostics).toMatchObject([
    { code: "DS0007", suggestion: expect.stringContaining(`<${name}>`) },
  ]);
});

test("unprepared Nuxt UI does not guess a prefix through unresolved extends", async () => {
  const result = await diagnose(
    {
      "nuxt.config.ts": `export default defineNuxtConfig({ modules: ['@nuxt/ui'], extends: ['./external'] })`,
      "app/pages/index.vue": rawButton,
    },
    { framework: "nuxt", dependencies: NUXT_UI },
  );
  expect(result.diagnostics).toEqual([]);
});

test("an unreadable ui.prefix or a local component with Nuxt UI's name suggests nothing", async () => {
  const computed = await diagnose(
    {
      "nuxt.config.ts": `const prefix = process.env.UI_PREFIX;\nexport default defineNuxtConfig({ modules: ["@nuxt/ui"], ui: { prefix } });\n`,
      "app/pages/index.vue": rawButton,
    },
    { framework: "nuxt", dependencies: NUXT_UI },
  );
  expect(computed.diagnostics).toEqual([]);

  const local = await diagnose(
    {
      "app/components/UButton.vue": `<template><div class="wrap"><button><slot /></button></div></template>`,
      "app/pages/index.vue": rawButton,
    },
    { framework: "nuxt", dependencies: NUXT_UI },
  );
  expect(local.diagnostics).toEqual([]);
});

test("a Nuxt app does not borrow a sibling workspace app's ui.prefix", async () => {
  const result = await diagnose(
    {
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
      "nuxt.config.ts": `export default defineNuxtConfig({ modules: ["@nuxt/ui"] });\n`,
      "app/pages/index.vue": rawButton,
      "apps/docs/package.json": JSON.stringify({
        name: "docs",
        dependencies: { nuxt: "^4.0.0", ...NUXT_UI },
      }),
      "apps/docs/nuxt.config.ts": `export default defineNuxtConfig({ modules: ["@nuxt/ui"], ui: { prefix: "Ui" } });\n`,
      "apps/docs/app/pages/index.vue": rawButton,
    },
    { framework: "nuxt", dependencies: NUXT_UI },
  );

  const byApp = Object.fromEntries(
    result.diagnostics.map((item) => [
      item.file.includes("/apps/docs/") ? "docs" : "root",
      item.suggestion,
    ]),
  );
  expect(result.diagnostics).toHaveLength(2);
  expect(byApp).toEqual({
    docs: expect.stringContaining("<UiButton>"),
    root: expect.stringContaining("<UButton>"),
  });
});
