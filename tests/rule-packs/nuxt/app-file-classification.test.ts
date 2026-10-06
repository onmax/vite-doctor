import { expect, test } from "vite-plus/test";
import { join, relative } from "pathe";
import { defineDoctorExtension, defineRulePack, runDoctor } from "../../../src/core/index.ts";
import type { DoctorRunResult } from "../../../src/core/index.ts";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import { noPlainEnvInAppCode } from "../../../src/rule-packs/nuxt/rules/nuxt.ts";
import { withFixture, writeFileManifest } from "./nuxt-modern-rules-fixture.ts";

const env = "export const key = process.env.API_KEY\n";
const vueEnv = `<script setup lang="ts">const key = process.env.API_KEY</script>`;
const config = "export default defineNuxtConfig({})\n";

async function reportedFiles(files: Record<string, string>) {
  const result = await runProjectFixture({
    framework: "nuxt",
    files,
    rules: [noPlainEnvInAppCode],
  });
  return nuxt0053Files(result.diagnostics);
}

function nuxt0053Files(diagnostics: DoctorRunResult["diagnostics"], root?: string) {
  return diagnostics
    .filter((diagnostic) => diagnostic.code === "NUXT0053")
    .map((diagnostic) =>
      root
        ? relative(root, diagnostic.file ?? "")
        : diagnostic.file?.replace(/^.*\/vite-doctor-fixture-[^/]+\//, ""),
    )
    .sort();
}

test("only classifies Nuxt 4 srcDir files as app code in a root Nuxt app", async () => {
  expect(
    await reportedFiles({
      "nuxt.config.ts": config,
      "app/pages/index.vue": vueEnv,
      "app/utils/env.ts": env,
      "scripts/release.mjs": env,
      "build/generate.mjs": env,
      "utils/node-only.ts": env,
      "server/api/key.ts": env,
    }),
  ).toEqual(["app/pages/index.vue", "app/utils/env.ts"]);
});

test("keeps the Nuxt 3 compatibility layout as app code", async () => {
  expect(
    await reportedFiles({
      "nuxt.config.ts": config,
      "app.vue": vueEnv,
      "pages/index.vue": vueEnv,
      "composables/useKey.ts": env,
      "scripts/release.mjs": env,
      "bin/cli.mjs": env,
    }),
  ).toEqual(["app.vue", "composables/useKey.ts", "pages/index.vue"]);
});

test("does not classify scripts or server code of a nested Nuxt app as app code", async () => {
  expect(
    await reportedFiles({
      "docs/nuxt.config.ts": config,
      "docs/app/pages/index.vue": vueEnv,
      "docs/scripts/sync.mjs": env,
      "docs/scripts/nested/build.mjs": env,
      "docs/server/api/key.ts": env,
      "docs/shared/env.ts": env,
    }),
  ).toEqual(["docs/app/pages/index.vue"]);
});

test("classifies root and nested Nuxt apps independently", async () => {
  expect(
    await reportedFiles({
      "nuxt.config.ts": config,
      "app/pages/index.vue": vueEnv,
      "scripts/release.mjs": env,
      "docs/nuxt.config.ts": config,
      "docs/app/components/Key.vue": vueEnv,
      "docs/scripts/sync.mjs": env,
    }),
  ).toEqual(["app/pages/index.vue", "docs/app/components/Key.vue"]);
});

test("uses the configured srcDir and layers from the Nuxt manifest", async () => {
  await withFixture(
    {
      "nuxt.config.ts": "export default defineNuxtConfig({ srcDir: 'src' })\n",
      "src/pages/index.vue": vueEnv,
      "app/legacy.ts": env,
      "scripts/release.mjs": env,
      "layers/base/nuxt.config.ts": config,
      "layers/base/app/composables/useKey.ts": env,
      "layers/base/scripts/build.mjs": env,
      "layers/base/server/api/key.ts": env,
    },
    {},
    async (root) => {
      await writeFileManifest(root, [], {
        srcDir: join(root, "src"),
        appDir: join(root, "src"),
        layers: [
          { root, srcDir: join(root, "src"), serverDir: join(root, "server"), priority: 0 },
          {
            root: join(root, "layers/base"),
            srcDir: join(root, "layers/base/app"),
            serverDir: join(root, "layers/base/server"),
            priority: 1,
          },
        ],
      });
      const result = await runDoctor({
        root,
        framework: "nuxt",
        cache: false,
        extensions: [
          defineDoctorExtension({
            name: "fixture",
            rulePacks: [
              defineRulePack({
                name: "fixture",
                version: "0.0.0",
                rules: [noPlainEnvInAppCode],
                presets: { recommended: [noPlainEnvInAppCode.meta.id] },
              }),
            ],
          }),
        ],
      });
      expect(nuxt0053Files(result.diagnostics, root)).toEqual([
        "layers/base/app/composables/useKey.ts",
        "src/pages/index.vue",
      ]);
    },
  );
});
