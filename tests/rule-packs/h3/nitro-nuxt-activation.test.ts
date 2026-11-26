import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { afterEach, expect, test } from "vite-plus/test";
import { runViteDoctor, viteDoctorRulePacks } from "../../../src/doctor.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "doctor-h3-activation-"));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const redirectHandler = `import { sendRedirect } from "h3"
export default defineHandler((event) => sendRedirect(event, "/next"))
`;

const nitroProject = () =>
  fixture({
    "package.json": JSON.stringify({ dependencies: { nitro: "3.0.0-beta.4" } }),
    "node_modules/nitro/package.json": JSON.stringify({
      name: "nitro",
      version: "3.0.0-beta.4",
      dependencies: { h3: "2.0.0-rc.26" },
    }),
    "node_modules/nitro/node_modules/h3/package.json": JSON.stringify({
      name: "h3",
      version: "2.0.0-rc.26",
    }),
    "server/api/redirect.ts": redirectHandler,
  });

const nuxtProject = () =>
  fixture({
    "package.json": JSON.stringify({ dependencies: { nuxt: "5.0.0-beta.2", vue: "3.5.18" } }),
    "node_modules/nuxt/package.json": JSON.stringify({
      name: "nuxt",
      version: "5.0.0-beta.2",
      dependencies: { nitro: "3.0.0-beta.4", vue: "3.5.18" },
    }),
    "node_modules/nuxt/node_modules/nitro/package.json": JSON.stringify({
      name: "nitro",
      version: "3.0.0-beta.4",
      dependencies: { h3: "2.0.0-rc.26" },
    }),
    "node_modules/nuxt/node_modules/nitro/node_modules/h3/package.json": JSON.stringify({
      name: "h3",
      version: "2.0.0-rc.26",
    }),
    "node_modules/vue/package.json": JSON.stringify({ name: "vue", version: "3.5.18" }),
    "nuxt.config.ts": "export default defineNuxtConfig({})\n",
    "server/api/redirect.ts": redirectHandler,
  });

test.each([
  ["nitro", nitroProject],
  ["nuxt", nuxtProject],
] as const)("%s projects get H3 rules from the H3 Rule Pack", async (framework, project) => {
  const root = project();

  const packs = await viteDoctorRulePacks({ root });
  expect(packs.filter((pack) => pack.name === "vite-doctor/h3")).toHaveLength(1);

  const result = await runViteDoctor({ root, cache: false });
  expect(result.framework).toBe(framework);
  const redirects = result.diagnostics.filter((item) => item.file.endsWith("redirect.ts"));
  expect(redirects).toContainEqual(
    expect.objectContaining({ code: "H30002", ruleId: "h3/migration/prefer-redirect-response" }),
  );
  expect(redirects.map((item) => item.ruleId)).not.toContain("nitro/h3/prefer-redirect-response");
  expect(redirects.filter((item) => item.code === "H30002")).toHaveLength(1);
});
