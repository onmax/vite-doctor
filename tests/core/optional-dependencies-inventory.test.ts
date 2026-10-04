import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { afterEach, expect, test } from "vite-plus/test";
import { detectProject, evaluatePackActivation, runDoctor } from "../../src/core/index.ts";
import { nuxtUiRulePack } from "../../src/rule-packs/nuxt/rules/nuxt-ui.ts";
import { vueUseRulePack } from "../../src/rule-packs/nuxt/rules/vueuse.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(manifest: Record<string, unknown>, files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "doctor-optional-inventory-"));
  roots.push(root);
  for (const [file, text] of Object.entries({
    "package.json": JSON.stringify({ type: "module", ...manifest }),
    ...files,
  })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

for (const [name, version] of [
  ["@nuxt/ui", "^4.0.0"],
  ["@vueuse/core", "^13.0.0"],
  ["@vitejs/plugin-vue", "^6.0.0"],
] as const) {
  test(`Project Inventory includes declared optional ${name}`, async () => {
    const root = fixture({ optionalDependencies: { [name]: version } });
    const project = await detectProject(root, "vite");
    expect(project.inventory?.packages).toEqual({ [name]: version });
  });
}

for (const [pack, name] of [
  [nuxtUiRulePack, "@nuxt/ui"],
  [vueUseRulePack, "@vueuse/core"],
] as const) {
  test(`${pack.name} activates from declared optional package evidence`, async () => {
    const root = fixture({
      dependencies: { nuxt: "4.5.1" },
      optionalDependencies: { [name]: "^4.0.0" },
    });
    const project = await detectProject(root, "nuxt", {
      nuxt: "4.5.1",
      nitro: "2.13.4",
      h3: "1.15.11",
      vue: "3.5.40",
      nuxtCompatibility: 4,
    });
    expect(evaluatePackActivation(pack, project).state).toBe("active");
  });
}

test("a Doctor Run includes diagnostics from an optional package's Recommended Preset", async () => {
  const root = fixture(
    { dependencies: { nuxt: "4.5.1" }, optionalDependencies: { "@nuxt/ui": "^4.0.0" } },
    {
      "app/pages/index.vue": "<script setup>useToast()</script>",
    },
  );
  const result = await runDoctor({
    root,
    framework: "nuxt",
    cache: false,
    runtimeTarget: {
      nuxt: "4.5.1",
      nitro: "2.13.4",
      h3: "1.15.11",
      vue: "3.5.40",
      nuxtCompatibility: 4,
    },
    extensions: [{ name: "fixture/optional-ui", rulePacks: [nuxtUiRulePack] }],
  });
  expect(result.diagnostics.map((d) => d.ruleId)).toEqual(["nuxt-ui/require-uapp-root"]);
});

test("optional declarations override duplicate production declarations", async () => {
  const root = fixture({
    dependencies: { "@nuxt/ui": "^3.0.0" },
    optionalDependencies: { "@nuxt/ui": "^4.0.0" },
  });
  expect((await detectProject(root)).inventory?.packages).toEqual({ "@nuxt/ui": "^4.0.0" });
});

test("missing optional runtime versions are not inferred from declared ranges", async () => {
  const root = fixture(
    { optionalDependencies: { vue: "^3.5.0" } },
    {
      "node_modules/vue/package.json": JSON.stringify({ name: "vue" }),
    },
  );
  const project = await detectProject(root, "vue");
  expect(project.inventory?.packages).toEqual({ vue: "^3.5.0" });
  expect(project.runtimeGraph?.packages.vue).toMatchObject({
    state: "unknown",
    declaration: "^3.5.0",
  });
  expect(project.runtimeGraph?.packages.vue?.version).toBeUndefined();
});

test("installed optional runtimes use the resolved package version", async () => {
  const root = fixture(
    { optionalDependencies: { vue: "^3.0.0" } },
    {
      "node_modules/vue/package.json": JSON.stringify({
        name: "vue",
        version: "3.5.40",
        main: "index.js",
      }),
      "node_modules/vue/index.js": "module.exports = {}",
    },
  );
  const project = await detectProject(root, "vue");
  expect(project.inventory?.packages).toEqual({ vue: "^3.0.0" });
  expect(project.runtimeGraph?.packages.vue).toMatchObject({
    state: "resolved",
    version: "3.5.40",
  });
});

test("existing dependency and devDependency precedence is preserved", async () => {
  const root = fixture({
    dependencies: { vue: "^3.4.0" },
    devDependencies: { vue: "^3.5.0", vite: "^8.0.0" },
  });
  expect((await detectProject(root)).inventory?.packages).toEqual({
    vue: "^3.5.0",
    vite: "^8.0.0",
  });
});
