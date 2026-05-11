import { describe, expect, test } from "vite-plus/test";
import { fileURLToPath } from "node:url";
import { relative } from "pathe";
import { $fetch, setup } from "@nuxt/test-utils/e2e";
import { defineDoctorPlugin, runDoctor, vueRulePack } from "../../core/src/index.ts";
import { nuxtRulePacks } from "../src/rules/index.ts";

const vueFixture = fileURLToPath(new URL("../fixtures/vue-all-issues", import.meta.url));
const nuxtFixture = fileURLToPath(new URL("../fixtures/nuxt-all-issues", import.meta.url));

test("Vue all-issues fixture reports the Vue rule pack", async () => {
  const result = await runDoctor({
    root: vueFixture,
    framework: "vue",
    plugins: [defineDoctorPlugin({ name: "e2e-vue", rulePacks: [vueRulePack] })],
  });

  expect(uniqueDiagnosticIdentities(result)).toHaveLength(result.diagnostics.length);
  expect(diagnosticKeys(result, vueFixture)).toEqual([
    "vue/computed/no-async:app.vue",
    "vue/computed/no-side-effects:app.vue",
    "vue/reactivity/defineprops-watch-getter:app.vue",
    "vue/reactivity/no-prop-mutation:app.vue",
    "vue/reactivity/no-ref-as-operand:app.vue",
    "vue/security/restrict-v-html:src/components/TemplateRefsAndHtml.vue",
    "vue/ssr/no-browser-api-in-setup:app.vue",
    "vue/template/prefer-use-template-ref:src/components/TemplateRefsAndHtml.vue",
    "vue/template/require-v-for-key:src/components/ListWithoutKey.vue",
    "vue/watch/no-after-await:src/components/WatchAfterAwait.vue",
  ]);
});

test("Nuxt all-issues fixture reports Nuxt and ecosystem rule packs", async () => {
  const result = await runDoctor({
    root: nuxtFixture,
    framework: "nuxt",
    plugins: [
      defineDoctorPlugin({ name: "e2e-vue", rulePacks: [vueRulePack] }),
      defineDoctorPlugin({ name: "e2e-nuxt", rulePacks: nuxtRulePacks() }),
    ],
  });

  expect(uniqueDiagnosticIdentities(result)).toHaveLength(result.diagnostics.length);
  expect(diagnosticKeys(result, nuxtFixture)).toEqual([
    "nuxt-better-auth/require-standard-auth-handler-mount:app/aaa-security.ts",
    "nuxt-content/no-querycontent-legacy-api:app/pages/account.vue",
    "nuxt-scripts/no-raw-third-party-script-tag:diagnostics/RawScript.vue",
    "nuxt-ui/prefer-u-button:app/pages/account.vue",
    "nuxt-ui/require-uapp-root:app/pages/account.vue",
    "nuxt/composables/no-nested-autoimport-assumption:app/composables/nested/useThing.ts",
    "nuxt/context/no-composable-after-await:app/composables/useWrappedUser.ts",
    "nuxt/context/no-composable-after-await:app/pages/wrapper.vue",
    "nuxt/context/no-navigateto-in-nitro:server/api/user.ts",
    "nuxt/context/no-usenuxtapp-in-nitro:server/api/user.ts",
    "nuxt/fetch/forward-auth-headers-ssr:app/components/IssuePanel.vue",
    "nuxt/fetch/forward-auth-headers-ssr:app/composables/useWrappedUser.ts",
    "nuxt/fetch/forward-auth-headers-ssr:app/pages/wrapper.vue",
    "nuxt/fetch/no-await-inside-custom-wrapper:app/composables/useWrappedUser.ts",
    "nuxt/fetch/no-await-inside-custom-wrapper:app/pages/wrapper.vue",
    "nuxt/fetch/no-raw-fetch-in-setup:app/components/IssuePanel.vue",
    "nuxt/fetch/prefer-create-use-fetch:app/composables/useWrappedUser.ts",
    "nuxt/fetch/require-stable-asyncdata-key:app/composables/useWrappedUser.ts",
    "nuxt/hydration/no-browser-global-in-universal-code:app/components/IssuePanel.vue",
    "nuxt/hydration/no-browser-side-effects-in-setup:app/components/IssuePanel.vue",
    "nuxt/hydration/no-client-conditional-in-template:app/components/IssuePanel.vue",
    "nuxt/hydration/prefer-usecookie-for-initial-client-state:app/components/IssuePanel.vue",
    "nuxt/imports/no-conflicting-usefetch-import:app/components/IssuePanel.vue",
    "nuxt/imports/no-explicit-auto-import:app/components/IssuePanel.vue",
    "nuxt/middleware/no-route-middleware-api-security:app/middleware/auth.ts",
    "nuxt/plugins/no-subdir-auto-registration-assumption:app/plugins/nested/analytics.ts",
    "nuxt/project/prefer-app-directory-placement:pages/legacy.vue",
    "nuxt/routing/no-hash-sensitive-route-fullpath-in-ssr-markup:app/components/IssuePanel.vue",
    "nuxt/routing/no-route-object-page-key:app/app.vue",
    "nuxt/routing/no-router-navigation-in-setup:app/pages/navigation.vue",
    "nuxt/routing/no-useroute-in-middleware:app/middleware/auth.ts",
    "nuxt/routing/prefer-nuxt-useroute:app/components/IssuePanel.vue",
    "nuxt/routing/prefer-nuxtpage-over-routerview:app/app.vue",
    "nuxt/routing/return-navigateto-in-middleware:app/middleware/auth.ts",
    "nuxt/runtime/no-secret-in-public-config:nuxt.config.ts",
    "nuxt/shared/no-nested-shared-autoimport-assumption:shared/utils/nested/math.ts",
    "nuxt/shared/no-vue-or-nitro-context-in-shared:shared/utils/state.ts",
    "nuxt/state/no-nonserializable-usestate:app/composables/useSocketState.ts",
    "nuxt/state/no-nonserializable-usestate:app/pages/state.vue",
    "nuxt/state/prefer-explicit-usestate-key-in-exported-composables:app/composables/useCounter.ts",
    "vueuse/no-nuxt-auto-import-collision:app/components/IssuePanel.vue",
    "vueuse/prefer-usewindow-size:app/components/IssuePanel.vue",
  ]);
});

describe("Nuxt all-issues fixture app", async () => {
  await setup({
    rootDir: nuxtFixture,
    setupTimeout: 60000,
  });

  test("boots with Nuxt test utils", async () => {
    const html = await $fetch("/smoke");
    expect(html).toContain("Nuxt all issues fixture");
  });
});

function diagnosticKeys(result: Awaited<ReturnType<typeof runDoctor>>, root: string): string[] {
  return [
    ...new Set(result.diagnostics.map((item) => `${item.ruleId}:${relative(root, item.file)}`)),
  ].sort();
}

function uniqueDiagnosticIdentities(result: Awaited<ReturnType<typeof runDoctor>>): string[] {
  return [
    ...new Set(
      result.diagnostics.map((item) =>
        [item.ruleId, item.file, item.range?.line, item.range?.column, item.message].join(":"),
      ),
    ),
  ];
}
