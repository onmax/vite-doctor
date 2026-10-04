import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { afterEach, expect, test } from "vite-plus/test";
import { cleanViteDoctorCache, runViteDoctor, viteDoctorExtensions } from "../../src/doctor.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(manifest: Record<string, unknown>, files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "doctor-optional-framework-"));
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

for (const [name, framework] of [
  ["nuxt", "nuxt"],
  ["@nuxt/kit", "nuxt"],
  ["nitro", "nitro"],
  ["nitropack", "nitro"],
  ["vue", "vue"],
] as const) {
  test(`optional ${name} selects the ${framework} builtin extension`, async () => {
    const root = fixture({ optionalDependencies: { [name]: "*" } });
    expect((await viteDoctorExtensions({ root })).map((extension) => extension.name)).toContain(
      `vite-doctor/builtin-${framework}`,
    );
  });

  test(`public Doctor Runs select ${framework} for optional ${name}`, async () => {
    const root = fixture({ optionalDependencies: { [name]: "*" } });
    const result = await runViteDoctor({ root, cache: false });
    expect(result.framework).toBe(framework);
    expect(result.project.framework).toBe(framework);
  });
}

test("an explicit framework still overrides optional framework declarations", async () => {
  const root = fixture({ optionalDependencies: { nuxt: "^4.0.0" } });
  const result = await runViteDoctor({ root, framework: "vite", cache: false });
  expect(result.framework).toBe("vite");
  expect(
    (await viteDoctorExtensions({ root, framework: "vite" })).map((extension) => extension.name),
  ).not.toContain("vite-doctor/builtin-nuxt");
});

test("unrelated optional packages do not select a framework", async () => {
  const root = fixture({ optionalDependencies: { "example-vue-helper": "*" } });
  expect((await runViteDoctor({ root, cache: false })).framework).toBe("vite");
});

test("Nuxt keeps precedence over Vue across declaration types", async () => {
  const root = fixture({
    dependencies: { vue: "^3.0.0" },
    optionalDependencies: { nuxt: "^4.0.0" },
  });
  expect((await runViteDoctor({ root, cache: false })).framework).toBe("nuxt");
});

test("an optional Vue declaration does not invent a runtime version", async () => {
  const root = fixture(
    { optionalDependencies: { vue: "^3.5.0" } },
    {
      "node_modules/vue/package.json": JSON.stringify({ name: "vue" }),
    },
  );
  const result = await runViteDoctor({ root, cache: false });
  expect(result.framework).toBe("vue");
  expect(result.project.runtimeGraph?.packages.vue).toMatchObject({
    state: "unknown",
    declaration: "^3.5.0",
  });
  expect(result.project.runtimeGraph?.packages.vue?.version).toBeUndefined();
});

test("cache cleaning uses the automatically selected optional Nuxt framework", async () => {
  const root = fixture(
    { optionalDependencies: { nuxt: "^4.0.0" } },
    {
      ".nuxt/doctor/cache/entry.json": "{}",
      ".vite-doctor/cache/entry.json": "{}",
    },
  );
  await cleanViteDoctorCache(root);
  expect(existsSync(join(root, ".nuxt/doctor/cache"))).toBe(false);
  expect(existsSync(join(root, ".vite-doctor/cache"))).toBe(true);
});
