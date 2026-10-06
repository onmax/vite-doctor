import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";

export async function withFixture(
  files: Record<string, string>,
  dependencies: Record<string, string>,
  run: (root: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "vue-doctor-modern-nuxt-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        type: "module",
        dependencies: { vue: "^3.5.0", nuxt: "^4.0.0", ...dependencies },
      }),
    );
    const runtimePackages = {
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
    };
    for (const [file, text] of Object.entries(runtimePackages)) {
      const absolute = join(root, file);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, text);
    }
    for (const [file, text] of Object.entries(files)) {
      const absolute = join(root, file);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, text);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function writeFileManifest(
  root: string,
  moduleSources: any[],
  extra: Record<string, unknown> = {},
) {
  const buildDir = join(root, ".nuxt");
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(
    join(buildDir, "doctor.manifest.json"),
    JSON.stringify(
      {
        nuxtVersion: "4",
        vueVersion: "3.5",
        rootDir: root,
        srcDir: root,
        appDir: join(root, "app"),
        buildDir,
        autoImports: [],
        components: [],
        layers: [{ root, priority: 0 }],
        aliases: {},
        routeRules: {},
        serverHandlers: [],
        modules: [],
        moduleSources,
        ...extra,
      },
      null,
      2,
    ),
  );
}
