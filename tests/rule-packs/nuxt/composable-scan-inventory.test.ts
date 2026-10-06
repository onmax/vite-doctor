import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { defineNuxtModule, loadNuxt } from "nuxt/kit";
import { expect, test } from "vite-plus/test";
import nuxtDoctorModule from "../../../src/rule-packs/nuxt/module.ts";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { exportNameMatchesFile } from "../../../src/rule-packs/nuxt/rules/nuxt/export-name-matches-file.ts";

test.each(
  [
    { scan: true, manualFirst: false, removeRoot: false },
    { scan: true, manualFirst: true, removeRoot: false },
    { scan: false, manualFirst: false, removeRoot: false },
    { scan: false, manualFirst: true, removeRoot: false },
    { scan: true, manualFirst: false, removeRoot: true },
    { scan: true, manualFirst: true, removeRoot: true },
  ].flatMap((scenario) =>
    ["none", "sync", "async"].map((decorator) => ({ ...scenario, decorator })),
  ),
)(
  "captures Nuxt's effective composable scan ($scan, manual module first: $manualFirst, root removed: $removeRoot, decorator: $decorator)",
  async ({ scan, manualFirst, removeRoot, decorator }) => {
    const root = mkdtempSync(join(tmpdir(), "doctor-composable-scan-"));
    const files = {
      "app/composables/useCart.ts": "export enum useShoppingCart { Item }",
      "app/composables/cart.ts": "export default function () {}",
      "app/composables/ignored.ts": "export default function () {}",
      "app/composables/useIgnored.ts": "export function useOther() {}",
      "app/composables/modifier-only.ts": "export default function () {}",
      "app/composables/direct-only.ts": "export default function () {}",
      "app/composables/nested/wrong.ts": "export default function () {}",
      "composables/wrong.ts": "export default function () {}",
      "base/source/composables/custom.ts": "export default function () {}",
      "base/composables/wrong.ts": "export default function () {}",
      "base/app/composables/wrong.ts": "export default function () {}",
      "disabled/app/composables/wrong.ts": "export default function () {}",
    };
    let nuxt: Awaited<ReturnType<typeof loadNuxt>> | undefined;
    const cwd = process.cwd();
    try {
      symlinkSync(
        fileURLToPath(new URL("../../../node_modules", import.meta.url)),
        join(root, "node_modules"),
        "junction",
      );
      for (const [file, source] of Object.entries({
        ...files,
        "package.json": JSON.stringify({ type: "module" }),
        "nuxt.config.ts": "export default { srcDir: 'app/' }",
        "base/nuxt.config.ts": "export default { srcDir: 'source/' }",
        "disabled/nuxt.config.ts": "export default { imports: { scan: false } }",
      })) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), source);
      }
      const manualModule = defineNuxtModule({
        async setup(_options, host) {
          if (decorator !== "none") {
            const callHook = host.callHook;
            host.callHook = function (
              this: typeof host,
              ...args: Parameters<typeof host.callHook>
            ) {
              if (decorator === "async")
                return Promise.resolve().then(() => Reflect.apply(callHook, this, args));
              return Reflect.apply(callHook, this, args);
            } as typeof host.callHook;
          }
          await host.callHook("imports:dirs", [join(root, "app/composables")]);
          host.hook("modules:done", async () => {
            await host.callHook("imports:dirs", [join(root, "app/composables")]);
          });
          let retainedDirs: unknown[] | undefined;
          let laterDirs = false;
          let nestedDirs = false;
          host.hook("imports:dirs", async (dirs) => {
            if (!nestedDirs) {
              nestedDirs = true;
              try {
                await host.callHook("imports:dirs", [join(root, "app/composables")]);
              } finally {
                nestedDirs = false;
              }
            }
            retainedDirs = dirs;
            const index = dirs.indexOf(join(root, "app/composables"));
            if (!laterDirs && removeRoot && index !== -1) dirs.splice(index, 1);
          });
          host.hook("ready", () => {
            if (removeRoot) retainedDirs?.push(join(root, "app/composables"));
            else retainedDirs?.splice(0);
          });
          host.hook("ready", async () => {
            // This invocation never changes the directories retained by Nuxt's scanner.
            laterDirs = true;
            await host.callHook("imports:dirs", [join(root, "app/composables")]);
          });
          host.hook("imports:context", (context) => {
            host.hook("ready", async () => {
              const imports = await context.getImports();
              expect(
                imports.some((entry) => entry.from === join(root, "app/composables/cart.ts")),
              ).toBe(scan && !removeRoot);
              expect(
                imports.some(
                  (entry) => entry.from === join(root, "base/source/composables/custom.ts"),
                ),
              ).toBe(scan);
            });
            host.hook("ready", async () => {
              await context.modifyDynamicImports(async (imports) => {
                imports.push({
                  name: "default",
                  as: "modifierOnly",
                  from: join(root, "app/composables/modifier-only.ts"),
                });
                await host.callHook("imports:extend", imports);
                return imports;
              });
            });
          });
          host.hook("ready", async () => {
            await host.callHook("imports:extend", [
              { name: "default", from: join(root, "app/composables/direct-only.ts") },
            ]);
          });
          let extending = false;
          host.hook("imports:extend", async (imports) => {
            if (extending) return;
            imports.push(
              { name: "default", as: "ignored", from: join(root, "app/composables/ignored.ts") },
              { name: "useOther", from: join(root, "app/composables/useIgnored.ts") },
              { name: "useShoppingCart", from: join(root, "app/composables/useCart.ts") },
            );
            extending = true;
            try {
              await host.callHook("imports:extend", imports);
            } finally {
              extending = false;
            }
          });
        },
      });
      // unimport resolves scan globs from process.cwd(); outside the fixture it crawls from `/`.
      process.chdir(root);
      nuxt = await loadNuxt({
        cwd: root,
        overrides: {
          modules: manualFirst
            ? [manualModule, nuxtDoctorModule]
            : [nuxtDoctorModule, manualModule],
          srcDir: "app",
          extends: ["./base", "./disabled"],
          imports: { scan },
          ignore: ["**/ignored.ts", "**/useIgnored.ts", "**/direct-only.ts", "**/modifier-only.ts"],
          telemetry: false,
        },
      });
      await nuxt.close();
      nuxt = undefined;
      const manifest = JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8"));
      expect(manifest.autoImports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: join(root, "app/composables/ignored.ts") }),
          expect.objectContaining({ from: join(root, "app/composables/useIgnored.ts") }),
        ]),
      );
      expect(manifest.scannedComposableFiles).toEqual(
        scan
          ? [
              ...(removeRoot ? [] : ["app/composables/cart.ts", "app/composables/useCart.ts"]),
              "base/source/composables/custom.ts",
            ]
          : [],
      );
      const result = await runRuleFixture({
        rule: exportNameMatchesFile,
        framework: "nuxt",
        files: {
          ...files,
          ".nuxt/doctor.manifest.json": JSON.stringify({
            generatedAt: new Date(Date.now() + 10000).toISOString(),
            nuxtVersion: "4.5.2",
            appDir: "app",
            autoImports: [],
            layers: [],
            scannedComposableFiles: manifest.scannedComposableFiles,
          }),
        },
      });
      expect(result.diagnostics.map((diagnostic) => diagnostic.code).sort()).toEqual(
        scan ? [...(removeRoot ? [] : ["NUXT0079", "NUXT0080"]), "NUXT0080"] : [],
      );
    } finally {
      await nuxt?.close();
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);
