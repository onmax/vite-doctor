import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { afterEach, expect, test } from "vite-plus/test";
import { detectProject } from "../../src/core/index.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function nuxtApp(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "doctor-nuxt-manifest-"));
  roots.push(root);
  const tree = {
    "package.json": JSON.stringify({ devDependencies: { nuxt: "^4.1.0", "vite-doctor": "*" } }),
    "app/app.vue": "<template><div /></template>\n",
    ...files,
  };
  for (const [file, text] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const withModule = `export default defineNuxtConfig({
  modules: ["vite-doctor/nuxt"],
  doctor: { rules: { "nuxt/async-data-handler-pure": "off" } },
});
`;

test("a Nuxt app that registers vite-doctor/nuxt without a prepared manifest is incomplete", async () => {
  const root = nuxtApp({ "nuxt.config.ts": withModule });

  const project = await detectProject(root, "auto", { nuxt: "4.1.0" });

  expect(project.evidenceGaps).toEqual([
    {
      source: "vite-doctor/nuxt",
      message: expect.stringContaining("Run nuxt prepare first"),
      files: [".nuxt/doctor.manifest.json"],
    },
  ]);
});

test("a prepared manifest or an app without the module has no manifest gap", async () => {
  const prepared = nuxtApp({
    "nuxt.config.ts": withModule,
    ".nuxt/doctor.manifest.json": JSON.stringify({ nuxtVersion: "4.1.0" }),
  });
  const withoutModule = nuxtApp({ "nuxt.config.ts": "export default defineNuxtConfig({});\n" });

  expect((await detectProject(prepared, "auto", { nuxt: "4.1.0" })).evidenceGaps).toBeUndefined();
  expect(
    (await detectProject(withoutModule, "auto", { nuxt: "4.1.0" })).evidenceGaps,
  ).toBeUndefined();
});

test("a nested workspace package that registers vite-doctor/nuxt leaves the root app complete", async () => {
  const root = nuxtApp({
    "pnpm-workspace.yaml": "packages:\n  - docs\n",
    "docs/package.json": JSON.stringify({ devDependencies: { nuxt: "^4.1.0" } }),
    "docs/nuxt.config.ts": withModule,
  });

  expect((await detectProject(root, "auto", { nuxt: "4.1.0" })).evidenceGaps).toBeUndefined();
});

test("detects the Doctor module through a static modules binding", async () => {
  const root = nuxtApp({
    "nuxt.config.ts": `const doctorModules = ["vite-doctor/nuxt"];
export default defineNuxtConfig({ modules: doctorModules });
`,
  });

  expect((await detectProject(root, "auto", { nuxt: "4.1.0" })).evidenceGaps).toEqual([
    expect.objectContaining({ source: "vite-doctor/nuxt" }),
  ]);
});

test("ignores unrelated modules properties and shadowed bindings", async () => {
  const root = nuxtApp({
    "nuxt.config.ts": `const modules = ["vite-doctor/nuxt"];
const unrelated = { modules };
export default defineNuxtConfig({
  modules: [],
  nested: { modules: ["vite-doctor/nuxt"] },
});
`,
  });

  expect((await detectProject(root, "auto", { nuxt: "4.1.0" })).evidenceGaps).toBeUndefined();
});

test.each([
  `export default defineNuxtConfig(() => ({ modules: ["vite-doctor/nuxt"] }));`,
  `const modules = ["vite-doctor/nuxt"]; export default defineNuxtConfig({ modules });`,
  `module.exports = defineNuxtConfig({ modules: ["vite-doctor/nuxt"] });`,
  `const config = { modules: ["vite-doctor/nuxt"] }; export = config;`,
  `export default defineNuxtConfig({ modules: ["vite-doctor/nuxt"] } satisfies NuxtConfig);`,
])("detects supported Nuxt config export forms", async (config) => {
  const root = nuxtApp({ "nuxt.config.ts": config });

  expect((await detectProject(root, "auto", { nuxt: "4.1.0" })).evidenceGaps).toEqual([
    expect.objectContaining({ source: "vite-doctor/nuxt" }),
  ]);
});
