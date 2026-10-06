import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, normalize } from "pathe";
import type { NuxtHooks } from "nuxt/schema";
import { afterEach, expect, expectTypeOf, test, vi } from "vite-plus/test";
import { main } from "../../../src/cli-main.ts";
import { hostDoctorExtensions, runViteDoctor } from "../../../src/doctor.ts";
import nuxtDoctorModule, { writeManifest } from "../../../src/rule-packs/nuxt/module.ts";
import type { NuxtModuleSource } from "../../../src/core/index.ts";

const extensionEntry = normalize(
  fileURLToPath(new URL("../../fixtures/extension-library/doctor.ts", import.meta.url)),
);
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function nuxtProject(): string {
  const root = mkdtempSync(join(tmpdir(), "doctor-nuxt-extension-hooks-"));
  roots.push(root);
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      type: "module",
      dependencies: { vue: "^3.5.0", nuxt: "^4.0.0" },
    }),
    "node_modules/nuxt/package.json": JSON.stringify({
      name: "nuxt",
      version: "4.0.0",
      dependencies: { nitropack: "2.12.0" },
    }),
    "node_modules/nuxt/node_modules/nitropack/package.json": JSON.stringify({
      name: "nitropack",
      version: "2.12.0",
      dependencies: { h3: "1.15.4" },
    }),
    "node_modules/nuxt/node_modules/nitropack/node_modules/h3/package.json": JSON.stringify({
      name: "h3",
      version: "1.15.4",
    }),
    "node_modules/vue/package.json": JSON.stringify({ name: "vue", version: "3.5.18" }),
    "app/utils/store.ts": 'import { kv } from "@vite-hub/kv/legacy";\nexport const store = kv;\n',
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

function fakeNuxt(root: string, register: (entries: string[]) => void) {
  return {
    options: { rootDir: root, srcDir: "app", buildDir: ".nuxt", modules: [] },
    async callHook(name: string, payload: unknown) {
      if (name === "doctor:extendExtensions") register(payload as string[]);
    },
  };
}

async function captureStdout(run: () => Promise<number>) {
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  const code = await run();
  vi.restoreAllMocks();
  return { code, output };
}

test("Nuxt hooks for Doctor are typed through nuxt/schema", () => {
  expectTypeOf<Parameters<NuxtHooks["doctor:extendExtensions"]>[0]>().toEqualTypeOf<string[]>();
  expectTypeOf<Parameters<NuxtHooks["doctor:extendSources"]>[0]>().toEqualTypeOf<
    NuxtModuleSource[]
  >();
  expectTypeOf<Parameters<NuxtHooks["doctor:context"]>[0]>().toHaveProperty("manifest");
});

test("the Nuxt 4 Bridge records registered Doctor Extension entries once as absolute paths", async () => {
  const root = nuxtProject();
  writeFileSync(join(root, "local-doctor.mjs"), "export default { name: 'local' };\n");
  const libraryDir = join(root, "node_modules/acme-lib");
  mkdirSync(join(libraryDir, "dist"), { recursive: true });
  writeFileSync(
    join(libraryDir, "package.json"),
    JSON.stringify({
      name: "acme-lib",
      type: "module",
      exports: { "./doctor": "./dist/doctor.mjs" },
    }),
  );
  writeFileSync(join(libraryDir, "dist/doctor.mjs"), "export default { name: 'acme' };\n");
  await writeManifest(
    fakeNuxt(root, (entries) => {
      entries.push(extensionEntry);
      entries.push(pathToFileURL(extensionEntry).href);
      entries.push(extensionEntry.replace(/\.ts$/, ""));
      entries.push("./local-doctor");
      entries.push("acme-lib/doctor");
    }),
  );
  const manifest = JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8"));
  expect(manifest.extensions).toEqual([
    extensionEntry,
    join(root, "local-doctor.mjs"),
    join(libraryDir, "dist/doctor.mjs"),
  ]);
});

test.each(["relative", "package", "absolute", "file URL"])(
  "the Nuxt 4 Bridge rejects an unresolved %s entry before writing the manifest",
  async (kind) => {
    const root = nuxtProject();
    const missing = join(root, "missing-doctor.mjs");
    const entry = {
      relative: "./missing-doctor",
      package: "missing-doctor-package/extension",
      absolute: missing,
      "file URL": pathToFileURL(missing).href,
    }[kind]!;
    await expect(
      writeManifest(fakeNuxt(root, (entries) => entries.push(extensionEntry, entry))),
    ).rejects.toMatchObject({ name: "DOC0029", message: expect.stringContaining(entry) });
    expect(existsSync(join(root, ".nuxt/doctor.manifest.json"))).toBe(false);
  },
);

test("Nuxt module Doctor Extensions join the shared Doctor Run only when host extensions are trusted", async () => {
  const root = nuxtProject();
  await writeManifest(fakeNuxt(root, (entries) => entries.push(extensionEntry)));

  const untrusted = await runViteDoctor({ root, framework: "nuxt", cache: false });
  expect(untrusted.diagnostics.map((item) => item.code)).not.toContain("VHUB0001");

  const trusted = await runViteDoctor({
    root,
    framework: "nuxt",
    cache: false,
    hostExtensions: true,
  });
  expect(trusted.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "VHUB0001",
      ruleId: "vitehub/no-legacy-kv-import",
      docs: "https://vitehub.example/doctor/VHUB0001",
    }),
  );
});

test("the Nuxt Doctor Command trusts host extensions; the standalone CLI needs a flag", async () => {
  const root = nuxtProject();
  await writeManifest(fakeNuxt(root, (entries) => entries.push(extensionEntry)));
  const args = ["explain", "VHUB0001", "--framework", "nuxt", "--format", "json"];

  expect((await captureStdout(() => main(args, root))).code).toBe(2);

  const flagged = await captureStdout(() => main([...args, "--host-extensions"], root));
  expect(flagged.code).toBe(0);
  const hostCommand = await captureStdout(() => main(args, root, { hostExtensions: true }));
  expect(hostCommand.code).toBe(0);
  expect(JSON.parse(hostCommand.output)).toMatchObject({
    id: "vitehub/no-legacy-kv-import",
    pack: "vitehub",
    diagnostics: [{ code: "VHUB0001", docs: "https://vitehub.example/doctor/VHUB0001" }],
  });

  const run = await captureStdout(() =>
    main([root, "--format", "agent", "--no-cache"], root, { hostExtensions: true }),
  );
  const agent = JSON.parse(run.output);
  expect(agent.diagnostics.map((item: { code: string }) => item.code)).toContain("VHUB0001");
  expect(agent.commandArgs.rerun).toContain("--host-extensions");
});

test("unloadable host extension entries stop the run with a coded diagnostic", async () => {
  const root = nuxtProject();
  writeFileSync(join(root, "broken-doctor.mjs"), "export default 42;\n");
  await writeManifest(fakeNuxt(root, (entries) => entries.push(join(root, "broken-doctor.mjs"))));
  await expect(
    hostDoctorExtensions({ root, framework: "nuxt", hostExtensions: true }),
  ).rejects.toMatchObject({ name: "DOC0029" });
});

test("the final Nuxt manifest write keeps entries registered before Nuxt removes its hooks", async () => {
  const root = nuxtProject();
  const hooks = new Map<string, Array<(payload: any) => unknown>>();
  const nuxt = {
    _version: "4.5.1",
    options: { rootDir: root, srcDir: "app", buildDir: ".nuxt", modules: [] },
    hook(name: string, callback: (payload: any) => unknown) {
      hooks.set(name, [...(hooks.get(name) ?? []), callback]);
    },
    async callHook(name: string, payload?: unknown) {
      for (const hook of hooks.get(name) ?? []) await hook(payload);
    },
  };
  nuxt.hook("doctor:extendExtensions", (entries: string[]) => entries.push(extensionEntry));
  await nuxtDoctorModule({}, nuxt as any);
  await nuxt.callHook("modules:done");
  const close = hooks.get("close") ?? [];
  hooks.clear();
  for (const hook of close) await hook(nuxt);

  const manifest = JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8"));
  expect(manifest.extensions).toEqual([extensionEntry]);
});

test("the Nuxt manifest preserves relative and absolute layer alias overrides", async () => {
  const root = nuxtProject();
  const aliases = {
    "~": ".",
    "@": "./custom",
    "~~": join(root, "server"),
    "@@": join(root, "layers/billing"),
  };
  const nuxt = fakeNuxt(root, () => {});
  const manifest = await writeManifest({
    ...nuxt,
    options: {
      ...nuxt.options,
      _layers: [
        {
          cwd: join(root, "layers/billing"),
          config: {
            rootDir: join(root, "layers/billing"),
            srcDir: join(root, "layers/billing/app"),
            alias: aliases,
          },
        },
      ],
    },
  });
  expect(manifest.layers[0]?.aliases).toEqual(aliases);
});
