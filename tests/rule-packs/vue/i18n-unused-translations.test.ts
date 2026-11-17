import { relative } from "pathe";
import { expect, test } from "vite-plus/test";
import type { DoctorRunResult } from "../../../src/core/index.ts";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { noUnusedTranslations } from "../../../src/rule-packs/vue/rules/vue/index.ts";

const vueI18n = { "vue-i18n": "^11.0.0" };
const nuxtI18n = { "@nuxtjs/i18n": "^10.0.0" };

function runVue(files: Record<string, string>) {
  return runRuleFixture({
    rule: noUnusedTranslations,
    framework: "vue",
    dependencies: vueI18n,
    files,
  });
}

function runNuxt(files: Record<string, string>) {
  return runRuleFixture({
    rule: noUnusedTranslations,
    framework: "nuxt",
    dependencies: nuxtI18n,
    files,
  });
}

function reportedKeys(result: DoctorRunResult): string[] {
  return result.diagnostics.map((item) => /^Translation key "(.*?)"/.exec(item.message)?.[1] ?? "");
}

function reportedLocations(result: DoctorRunResult) {
  return result.diagnostics.map((item) => [
    reportedKeys({ ...result, diagnostics: [item] })[0],
    relative(result.root, item.file ?? ""),
  ]);
}

test("reports unused nested base locale keys with high confidence and scan evidence", async () => {
  const result = await runVue({
    "src/App.vue": `<template>{{ t('common.save') }}</template>`,
    "src/main.ts": `import { createI18n } from 'vue-i18n'`,
    "locales/en.json": JSON.stringify({
      common: { save: "Save", cancel: "Cancel" },
    }),
    "locales/fr.json": JSON.stringify({
      common: { save: "Enregistrer", cancel: "Annuler", frOnly: "Seulement" },
    }),
  });

  expect(result.diagnostics).toHaveLength(1);
  const [diagnostic] = result.diagnostics;
  expect(diagnostic!.message).toBe(
    'Translation key "common.cancel" in base locale "en" has no reference: no translation call, <i18n-t>, v-t, linked message, or string literal in 2 scanned source files uses it.',
  );
  expect(diagnostic!.confidence).toBe("heuristic-high");
  expect(diagnostic!.evidence).toEqual([
    {
      kind: "facts",
      summary:
        "Scanned 2 source files and 1 translation reference; none uses this key, its prefix, or a linked message that points to it.",
    },
  ]);
});

test("ignores locale metadata keys", async () => {
  const result = await runVue({
    "src/App.vue": `<template>{{ t('home.title') }}</template>`,
    "locales/en.json": JSON.stringify({
      $schema: "https://example.com/schema.json",
      home: { title: "Home", subtitle: "Welcome" },
    }),
  });

  expect(reportedKeys(result)).toEqual(["home.subtitle"]);
});

test("reports the key location in JSON and module locale files across every default locale dir", async () => {
  const result = await runVue({
    "src/App.vue": `<template>{{ $t('nav.home') }}</template>`,
    "src/store.ts": `export const title = t("nav.about")`,
    "src/View.tsx": `export const View = () => <p>{t('form.save')}</p>`,
    "src/router.js": "i18n.global.t(`form.cancel`)",
    "src/Button.jsx": `export const Button = () => te('form.reset')`,
    "public/legacy.js": `t('nav.blog')`,
    "node_modules/pkg/index.js": `t('nav.contact')`,
    "locales/en.json": `{
  "nav": {
    "home": "Home",
    "about": "About",
    "blog": "Blog",
    "contact": "Contact"
  },
  "form": {
    "save": "Save",
    "cancel": "Cancel",
    "reset": "Reset",
    "submit": "Submit"
  }
}`,
    "i18n/locales/en.ts": `export default defineI18nLocale({
  footer: { 'legal': 'Legal', home: 'Home' },
})`,
    "locales/fr.json": JSON.stringify({ nav: { unusedFr: "Seulement" } }),
  });

  expect(
    result.diagnostics.map((item) => [
      reportedKeys({ ...result, diagnostics: [item] })[0],
      relative(result.root, item.file ?? ""),
      item.range?.line,
      item.range?.column,
    ]),
  ).toEqual([
    ["footer.legal", "i18n/locales/en.ts", 2, 13],
    ["footer.home", "i18n/locales/en.ts", 2, 38],
    ["nav.blog", "locales/en.json", 5, 5],
    ["nav.contact", "locales/en.json", 6, 5],
    ["form.submit", "locales/en.json", 12, 5],
  ]);
});

test("1a: <i18n-t> and <I18nT> keypath attributes count as usage", async () => {
  const result = await runVue({
    "src/App.vue": `<template>
  <i18n-t keypath="home.intro" tag="p"><template #name>Vue</template></i18n-t>
  <I18nT keypath='home.terms' />
  <i18n-t :keypath="'home.bound'" />
  <i18n-t v-bind:keypath="\`home.longhand\`" />
</template>`,
    "locales/en.json": JSON.stringify({
      home: { intro: "{name}", terms: "Terms", bound: "Bound", longhand: "Long", unused: "Unused" },
    }),
  });

  expect(reportedKeys(result)).toEqual(["home.unused"]);
  expect(result.diagnostics[0]!.confidence).toBe("heuristic-high");
});

test("1b: v-t string and object paths count as usage", async () => {
  const result = await runVue({
    "src/App.vue": `<template>
  <p v-t="'nav.home'"></p>
  <p v-t="{ path: 'nav.about', args: { n: 1 } }"></p>
  <p v-t.preserve='"nav.preserved"'></p>
</template>`,
    "locales/en.json": JSON.stringify({
      nav: { home: "Home", about: "About", preserved: "Kept", blog: "Blog" },
    }),
  });

  expect(reportedKeys(result)).toEqual(["nav.blog"]);
  expect(result.diagnostics[0]!.confidence).toBe("heuristic-high");
});

test("1c: tc, tm, global and $i18n calls and useI18n aliases count as usage; rt, d and n do not read keys", async () => {
  const result = await runVue({
    "src/App.vue": `<script setup lang="ts">
import { useI18n } from 'vue-i18n'
const { t: translate, tm: messagesOf, rt } = useI18n()
const items = messagesOf('features')
const label = translate('alias.used')
</script>
<template>
  <p>{{ tc('cart.items', 2) }} {{ $tc('cart.count', 1) }}</p>
  <p v-for="item in $tm('faq')">{{ rt(item.question) }} {{ d(date) }} {{ n(price) }}</p>
  <p>{{ $i18n.t('nav.instance') }}</p>
</template>`,
    "src/legal.ts": `export const legal = i18n.global.tm('legal')`,
    "locales/en.json": JSON.stringify({
      alias: { used: "Alias" },
      cart: { items: "Items", count: "Count", unused: "Unused" },
      features: { fast: "Fast", small: "Small" },
      faq: { first: { question: "Why?" } },
      legal: { terms: "Terms" },
      nav: { instance: "Instance" },
    }),
  });

  expect(reportedKeys(result)).toEqual(["cart.unused"]);
  expect(result.diagnostics[0]!.confidence).toBe("heuristic-high");
});

test("1d: template literal and concatenated keys with a static prefix mark the whole prefix as used", async () => {
  const result = await runVue({
    "src/App.vue": `<template>
  <p>{{ t(\`status.\${state}\`) }}</p>
  <p>{{ t('errors.' + code) }}</p>
</template>`,
    "locales/en.json": JSON.stringify({
      status: { active: "Active", archived: "Archived" },
      errors: { e404: "Missing", e500: "Broken" },
      other: { key: "Other" },
    }),
  });

  expect(reportedKeys(result)).toEqual(["other.key"]);
  expect(result.diagnostics[0]!.confidence).toBe("heuristic-high");
});

test("1e: linked messages in locale values mark their target keys as used", async () => {
  const result = await runVue({
    "src/App.vue": `<template>{{ t('actions.saveAll') }} {{ t('actions.store') }} {{ t('actions.quoted') }}</template>`,
    "locales/en.json": JSON.stringify({
      common: { save: "Save", store: "Store", quoted: "Quoted", unused: "Unused" },
      actions: {
        saveAll: "@:common.save all",
        store: "@.lower:common.store",
        quoted: "@:{'common.quoted'}",
      },
    }),
  });

  expect(reportedKeys(result)).toEqual(["common.unused"]);
});

test("1f: a source string literal equal to a full key counts as usage, locale values do not", async () => {
  const result = await runNuxt({
    "app/components/Nav.vue": `<script setup lang="ts">
const nav = [{ label: 'nav.home', to: '/' }]
</script>
<template><a v-for="item in nav">{{ $t(item.label) }}</a></template>`,
    "app/pages/index.vue": `<script setup lang="ts">
definePageMeta({ title: 'pages.home' })
</script>`,
    "i18n/locales/en.json": JSON.stringify({
      nav: { home: "Home", unused: "Unused" },
      pages: { home: "Home page" },
      self: { path: "self.path" },
    }),
  });

  expect(reportedKeys(result)).toEqual(["nav.unused", "self.path"]);
});

test("1g: sentence and unicode keys are matched", async () => {
  const result = await runVue({
    "src/App.vue": `<template>
  <p>{{ t('Save changes') }}</p>
  <p>{{ t("Don't save") }}</p>
  <p>{{ $t('Größe') }}</p>
  <p>{{ t('こんにちは') }}</p>
</template>`,
    "locales/en.json": JSON.stringify({
      "Save changes": "Save changes",
      "Don't save": "Don't save",
      Größe: "Size",
      こんにちは: "Hello",
      "Delete everything": "Delete everything",
    }),
  });

  expect(reportedKeys(result)).toEqual(["Delete everything"]);
});

test("1h: fully dynamic calls keep the report but lower confidence and name a call that could reach the key", async () => {
  const result = await runVue({
    "src/App.vue": `<template>{{ $t('home.title') }} {{ t(prefix + name) }}</template>`,
    "src/menu.ts": `export const label = (key: string) => t(key)
function t(key: string) { return key }`,
    "locales/en.json": JSON.stringify({
      home: { title: "Home", dynamic: "Dynamic" },
    }),
  });

  expect(result.diagnostics).toHaveLength(1);
  const [diagnostic] = result.diagnostics;
  expect(diagnostic!.message).toBe(
    'Translation key "home.dynamic" in base locale "en" has no static reference, but 2 dynamic translation calls (first in src/App.vue) build keys Doctor cannot resolve and could reach it.',
  );
  expect(diagnostic!.confidence).toBe("heuristic-medium");
  expect(diagnostic!.evidence).toEqual([
    {
      kind: "facts",
      summary:
        "Scanned 2 source files and 3 translation references; none uses this key, its prefix, or a linked message that points to it.",
    },
    {
      kind: "facts",
      summary:
        "2 translation calls pass a key that is only known at runtime, so usage is partial evidence.",
      file: expect.stringMatching(/src\/App\.vue$/),
      range: expect.objectContaining({ line: 1, column: 37 }),
    },
  ]);
});

test("1h: a template Doctor cannot parse is scanned with a fallback pattern and lowers confidence", async () => {
  const result = await runVue({
    "src/App.vue": `<template lang="pug">
p {{ $t('home.title') }}
</template>`,
    "locales/en.json": JSON.stringify({ home: { title: "Home", unused: "Unused" } }),
  });

  expect(reportedKeys(result)).toEqual(["home.unused"]);
  expect(result.diagnostics[0]!.confidence).toBe("heuristic-medium");
  expect(result.diagnostics[0]!.message).toBe(
    'Translation key "home.unused" in base locale "en" has no static reference, but Doctor could only pattern-scan 1 source file (first src/App.vue), so a reference there may be missed.',
  );
});

test("1h: a linked message with a runtime key counts as a dynamic reference", async () => {
  const result = await runVue({
    "src/App.vue": `<template>{{ t('labels.action') }}</template>`,
    "locales/en.json": JSON.stringify({
      labels: { action: "@:{target}" },
      verbs: { save: "Save" },
    }),
  });

  expect(reportedKeys(result)).toEqual(["verbs.save"]);
  expect(result.diagnostics[0]!.confidence).toBe("heuristic-medium");
});

test("1i: scans .mjs, .cjs, .mts and .cts sources, skips build and cache dirs, and does not read locale modules as usage", async () => {
  const result = await runVue({
    "src/a.mjs": `t('src.mjs')`,
    "src/b.cjs": `t('src.cjs')`,
    "src/c.mts": `t('src.mts')`,
    "src/d.cts": `t('src.cts')`,
    ".git/hooks/x.js": `t('ignored.git')`,
    ".vercel/output/x.js": `t('ignored.vercel')`,
    ".netlify/functions/x.js": `t('ignored.netlify')`,
    ".data/x.js": `t('ignored.data')`,
    ".cache/x.js": `t('ignored.cache')`,
    "locales/en.ts": `export default {
  src: { mjs: 'a', cjs: 'b', mts: 'c', cts: 'd' },
  ignored: { git: 'g', vercel: 'v', netlify: 'n', data: 'd', cache: 'c' },
  self: { key: 'self.key' },
}`,
  });

  expect(reportedKeys(result)).toEqual([
    "ignored.git",
    "ignored.vercel",
    "ignored.netlify",
    "ignored.data",
    "ignored.cache",
    "self.key",
  ]);
});

test("2a: Nuxt i18n v9+ resolves langDir inside restructureDir", async () => {
  const result = await runNuxt({
    "nuxt.config.ts": `export default defineNuxtConfig({ modules: ['@nuxtjs/i18n'], i18n: { langDir: 'lang', defaultLocale: 'en' } })`,
    "app/pages/index.vue": `<template>{{ $t('home.title') }}</template>`,
    "i18n/lang/en.json": JSON.stringify({ home: { title: "Home", subtitle: "Welcome" } }),
  });

  expect(reportedLocations(result)).toEqual([["home.subtitle", "i18n/lang/en.json"]]);
});

test("2a: Nuxt i18n reads a custom restructureDir and module tuple options", async () => {
  const result = await runNuxt({
    "nuxt.config.ts": `export default defineNuxtConfig({
  modules: [['@nuxtjs/i18n', { restructureDir: 'translations', langDir: 'lang' }]],
})`,
    "app/pages/index.vue": `<template>{{ $t('home.title') }}</template>`,
    "translations/lang/en.json": JSON.stringify({ home: { title: "Home", subtitle: "Welcome" } }),
  });

  expect(reportedLocations(result)).toEqual([["home.subtitle", "translations/lang/en.json"]]);
});

test("2a: root-relative langDir layouts from older Nuxt i18n keep working", async () => {
  const result = await runNuxt({
    "nuxt.config.ts": `export default defineNuxtConfig({ i18n: { langDir: './app/i18n' } })`,
    "app/pages/index.vue": `<template>{{ $t('home.title') }}</template>`,
    "app/i18n/en.json": JSON.stringify({ home: { title: "Home", subtitle: "Welcome" } }),
  });

  expect(reportedLocations(result)).toEqual([["home.subtitle", "app/i18n/en.json"]]);
});

test("2b: defaultLocale picks the base locale through the locales file mapping", async () => {
  const result = await runNuxt({
    "nuxt.config.ts": `export default defineNuxtConfig({
  i18n: {
    defaultLocale: 'fr',
    locales: [
      { code: 'fr', file: 'fr-FR.json' },
      { code: 'en', files: ['en-US.json'] },
    ],
  },
})`,
    "app/pages/index.vue": `<template>{{ $t('home.title') }}</template>`,
    "i18n/locales/fr-FR.json": JSON.stringify({ home: { title: "Accueil", frOnly: "Seulement" } }),
    "i18n/locales/en-US.json": JSON.stringify({ home: { title: "Home", enOnly: "Only" } }),
  });

  expect(reportedLocations(result)).toEqual([["home.frOnly", "i18n/locales/fr-FR.json"]]);
  expect(result.diagnostics[0]!.message).toContain('in base locale "fr"');
});

test("2c: nested per-locale directories merge keys at the locale root and also accept a file-name namespace", async () => {
  const result = await runVue({
    "src/App.vue": `<template>{{ t('save') }} {{ t('home.title') }}</template>`,
    "locales/en/common.json": JSON.stringify({ save: "Save", cancel: "Cancel" }),
    "locales/en/home.json": JSON.stringify({ title: "Home" }),
    "locales/fr/common.json": JSON.stringify({ save: "Enregistrer", frOnly: "Seulement" }),
  });

  expect(reportedLocations(result)).toEqual([["cancel", "locales/en/common.json"]]);
});

test("a project that uses every key reports nothing", async () => {
  const result = await runNuxt({
    "nuxt.config.ts": `export default defineNuxtConfig({ i18n: { defaultLocale: 'en', langDir: 'locales' } })`,
    "app/pages/index.vue": `<script setup lang="ts">
const { t } = useI18n()
</script>
<template>
  <h1>{{ t('home.title') }}</h1>
  <i18n-t keypath="home.intro" tag="p" />
  <p v-t="'home.footer'" />
</template>`,
    "i18n/locales/en.json": JSON.stringify({
      home: { title: "Home", intro: "Intro", footer: "@:common.copyright" },
      common: { copyright: "(c)" },
    }),
    "i18n/locales/fr.json": JSON.stringify({ home: { title: "Accueil" } }),
  });

  expect(result.diagnostics).toEqual([]);
});

test("translation component object bindings retain patterns and opaque uncertainty", async () => {
  for (const tag of ["i18n-t", "i18n"]) {
    const path = tag === "i18n" ? "path" : "keypath";
    const known = await runVue({
      "src/App.vue": `<script setup>const section = 'title'</script><template><${tag} v-bind="{ ${path}: 'home.' + section }" /></template>`,
      "locales/en.json": JSON.stringify({ home: { title: "Home" }, unused: "Unused" }),
    });
    expect(reportedKeys(known)).toEqual(["unused"]);
    const opaque = await runVue({
      "src/App.vue": `<template><${tag} v-bind="translationProps" /></template>`,
      "locales/en.json": JSON.stringify({ unused: "Unused" }),
    });
    expect(opaque.diagnostics[0]!.confidence).toBe("heuristic-medium");
  }
});

test("shared declared files preserve every locale membership and nested paths", async () => {
  for (const path of ["fr.json", "messages/fr.json", "fr/pages/home.json"]) {
    const result = await runNuxt({
      "nuxt.config.ts": `export default defineNuxtConfig({ i18n: { defaultLocale: 'fr', locales: [{ code: 'fr', file: '${path}' }, { code: 'fr-CA', files: ['${path}', 'fr-CA.json'] }, { code: 'en', file: 'en.json' }] } })`,
      [`i18n/locales/${path}`]: JSON.stringify({ home: { frOnly: "French" } }),
      "i18n/locales/fr-CA.json": JSON.stringify({ regional: "Regional" }),
      "i18n/locales/en.json": JSON.stringify({ enOnly: "English" }),
    });
    expect(reportedLocations(result)).toEqual([["home.frOnly", `i18n/locales/${path}`]]);
    expect(result.diagnostics[0]!.message).toContain('in base locale "fr"');
  }
});

test("template-only optional translation calls retain subtree and dynamic evidence", async () => {
  const subtree = await runVue({
    "src/App.vue": `<template>{{ $tm?.('home') }}</template>`,
    "locales/en.json": JSON.stringify({ home: { title: "Home" } }),
  });
  expect(subtree.diagnostics).toEqual([]);
  const dynamic = await runVue({
    "src/App.vue": `<template>{{ $t?.(key) }}</template>`,
    "locales/en.json": JSON.stringify({ unused: "Unused" }),
  });
  expect(dynamic.diagnostics[0]!.confidence).toBe("heuristic-medium");
});

test("indirect source literals decode JavaScript escapes", async () => {
  const result = await runVue({
    "src/main.ts": String.raw`const items = ['\u0068ome.title', '\x68ome.hex', 'home.\nline', '\u{68}ome.point']; items.map(key => t(key))`,
    "locales/en.json": JSON.stringify({
      home: { title: "Home", hex: "Hex", "\nline": "Line", point: "Point" },
    }),
  });
  expect(result.diagnostics).toEqual([]);
});
