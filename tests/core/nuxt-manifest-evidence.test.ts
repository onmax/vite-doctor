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
