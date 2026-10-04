import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { describe, expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../src/core/testkit.ts";
import { doctor } from "../../src/plugin.ts";
import { noDynamicNewUrl } from "../../src/rules.ts";

describe("Vite asset URL templates", () => {
  test.each([
    '""',
    '"./images/logo.png"',
    "`./images/${name}.png`",
    "`../images/${name}.png`",
    "`/src/images/${name}.png`",
    "`./images/${folder}/${name}.png`",
  ])("allows a static path or a constrained template: %s", async (expression) => {
    const result = await runRuleFixture({
      rule: noDynamicNewUrl,
      framework: "vite",
      files: { "src/main.ts": `const image = new URL(${expression}, import.meta.url)` },
    });
    expect(result.diagnostics).toEqual([]);
  });

  test.each(["name", "`${name}.png`", "`${directory}/${name}.png`", "`images/${name}.png`"])(
    "reports asset paths without a supported static prefix: %s",
    async (expression) => {
      const result = await runRuleFixture({
        rule: noDynamicNewUrl,
        framework: "vite",
        files: { "src/main.ts": `const image = new URL(${expression}, import.meta.url)` },
      });
      expect(result.diagnostics.map(({ code }) => code)).toEqual(["VITE0001"]);
    },
  );

  test("allows Vite to emit assets selected by a constrained URL template", async () => {
    const root = await mkdtemp(join(tmpdir(), "doctor-asset-url-"));
    try {
      await mkdir(join(root, "src/images"), { recursive: true });
      await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
      await writeFile(
        join(root, "index.html"),
        '<script type="module" src="/src/main.ts"></script>',
      );
      await writeFile(
        join(root, "src/main.ts"),
        "const name = location.hash.slice(1); const image = new URL(`./images/${name}.svg`, import.meta.url); console.log(image.href)",
      );
      await writeFile(
        join(root, "src/images/red.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="red"/></svg>',
      );
      await writeFile(
        join(root, "src/images/blue.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="blue"/></svg>',
      );

      const result = await build({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [
          doctor({
            rules: "vite/assets/no-dynamic-new-url",
            mode: "error",
            maxWarnings: 0,
            cache: false,
          }),
        ],
        build: { write: false, assetsInlineLimit: 0 },
      });
      const outputs = Array.isArray(result) ? result : [result];
      const assets = outputs.flatMap((output) => ("output" in output ? output.output : []));
      expect(assets.filter(({ fileName }) => fileName.endsWith(".svg"))).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("allows Vite aliases selected by a dynamic URL template", async () => {
    const root = await mkdtemp(join(tmpdir(), "doctor-asset-alias-"));
    try {
      await mkdir(join(root, "src/images"), { recursive: true });
      await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
      await writeFile(
        join(root, "index.html"),
        '<script type="module" src="/src/main.ts"></script>',
      );
      await writeFile(
        join(root, "src/main.ts"),
        "const name = location.hash.slice(1); const image = new URL(`@assets/${name}.svg`, import.meta.url); console.log(image.href)",
      );
      await writeFile(
        join(root, "src/images/red.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg"/>',
      );
      await writeFile(
        join(root, "src/images/blue.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg"/>',
      );

      const result = await build({
        root,
        configFile: false,
        logLevel: "silent",
        resolve: { alias: { "@assets": join(root, "src/images") } },
        plugins: [
          doctor({
            rules: "vite/assets/no-dynamic-new-url",
            mode: "error",
            maxWarnings: 0,
            cache: false,
          }),
        ],
        build: { write: false, assetsInlineLimit: 0 },
      });
      const outputs = Array.isArray(result) ? result : [result];
      const assets = outputs.flatMap((output) => ("output" in output ? output.output : []));
      expect(assets.filter(({ fileName }) => fileName.endsWith(".svg"))).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("allows regex Vite aliases selected by a dynamic URL template", async () => {
    const root = await mkdtemp(join(tmpdir(), "doctor-asset-regex-alias-"));
    try {
      await mkdir(join(root, "src/images"), { recursive: true });
      await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
      await writeFile(
        join(root, "index.html"),
        '<script type="module" src="/src/main.ts"></script>',
      );
      await writeFile(
        join(root, "src/main.ts"),
        "const name = location.hash.slice(1); const image = new URL(`@assets/${name}.svg`, import.meta.url); console.log(image.href)",
      );
      await writeFile(
        join(root, "src/images/red.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg"/>',
      );

      const result = await build({
        root,
        configFile: false,
        logLevel: "silent",
        resolve: { alias: [{ find: /^@assets/, replacement: join(root, "src/images") }] },
        plugins: [
          doctor({
            rules: "vite/assets/no-dynamic-new-url",
            mode: "error",
            maxWarnings: 0,
            cache: false,
          }),
        ],
        build: { write: false, assetsInlineLimit: 0 },
      });
      const outputs = Array.isArray(result) ? result : [result];
      const assets = outputs.flatMap((output) => ("output" in output ? output.output : []));
      expect(assets.filter(({ fileName }) => fileName.endsWith(".svg"))).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
