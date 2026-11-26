import { expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import { explainRule } from "../../../src/core/reports.ts";
import {
  preferProjectComponent,
  unreadableContract,
} from "../../../src/rule-packs/design-system/index.ts";
import { nuxtUiRulePack } from "../../../src/rule-packs/nuxt/rules/nuxt-ui.ts";
import { getDiagnosticDocuments } from "../../../docs/rules/source.ts";
import nuxtDoctorModule from "../../../src/rule-packs/nuxt/module.ts";
import { withFixture } from "../nuxt/nuxt-modern-rules-fixture.ts";

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
import { Button } from "@/components/ui/button";
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
