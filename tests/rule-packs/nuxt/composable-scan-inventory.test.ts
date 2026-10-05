import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { loadNuxt } from "nuxt/kit";
import { expect, test } from "vite-plus/test";
import nuxtDoctorModule from "../../../src/rule-packs/nuxt/module.ts";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { exportNameMatchesFile } from "../../../src/rule-packs/nuxt/rules/nuxt/export-name-matches-file.ts";

test.each([true, false])(
  "captures Nuxt's effective composable scan (scan: %s)",
  async (scan) => {
    const root = mkdtempSync(join(tmpdir(), "doctor-composable-scan-"));
    const files = {
      "app/composables/useCart.ts": "export enum useShoppingCart { Item }",
      "app/composables/ignored.ts": "export default function () {}",
      "app/composables/nested/wrong.ts": "export default function () {}",
      "composables/wrong.ts": "export default function () {}",
      "base/source/composables/custom.ts": "export default function () {}",
      "base/composables/wrong.ts": "export default function () {}",
      "base/app/composables/wrong.ts": "export default function () {}",
      "disabled/app/composables/wrong.ts": "export default function () {}",
    };
    let nuxt: Awaited<ReturnType<typeof loadNuxt>> | undefined;
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
      nuxt = await loadNuxt({
        cwd: root,
        overrides: {
          modules: [nuxtDoctorModule],
          srcDir: "app",
          extends: ["./base", "./disabled"],
          imports: { scan },
          ignore: ["**/ignored.ts"],
          telemetry: false,
        },
      });
      await nuxt.close();
      nuxt = undefined;
      const manifest = JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8"));
      expect(manifest.scannedComposableFiles).toEqual(
        scan ? ["app/composables/useCart.ts", "base/source/composables/custom.ts"] : [],
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
        scan ? ["NUXT0079", "NUXT0080"] : [],
      );
    } finally {
      await nuxt?.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);
