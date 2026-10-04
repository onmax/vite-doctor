import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../src/core/testkit.ts";
import { doctor } from "../../src/plugin.ts";
import { noPublicSrcImport } from "../../src/rules.ts";

test.each([
  "@acme/public/logo.svg",
  "some-package/public/logo.svg",
  "public/logo.svg",
  "./public/logo.svg",
  "../src/public/logo.svg",
  "/src/public/logo.svg",
  "../public/../src/logo.svg",
  "../publicity/logo.svg",
  "../../public/logo.svg",
  "https://cdn.example/public/logo.svg",
  "//cdn.example/public/logo.svg",
  "../public/data.json?raw",
])("allows imports outside the root public directory: %s", async (source) => {
  const result = await runRuleFixture({
    rule: noPublicSrcImport,
    framework: "vite",
    files: { "src/main.ts": `import asset from ${JSON.stringify(source)}; console.log(asset)` },
  });
  expect(result.diagnostics).toEqual([]);
});

test.each([
  "../public/logo.svg",
  "../public/logo.svg?url",
  "/public/logo.svg",
  "../src/../public/logo.svg",
])("reports an import from the root public directory: %s", async (source) => {
  const result = await runRuleFixture({
    rule: noPublicSrcImport,
    framework: "vite",
    files: { "src/main.ts": `import asset from ${JSON.stringify(source)}; console.log(asset)` },
  });
  expect(result.diagnostics.map(({ code }) => code)).toEqual(["VITE0002"]);
});

test("resolves relative public imports from the importing file", async () => {
  const result = await runRuleFixture({
    rule: noPublicSrcImport,
    framework: "vite",
    files: { "src/components/main.ts": "import asset from '../../public/logo.svg'" },
  });
  expect(result.diagnostics.map(({ code }) => code)).toEqual(["VITE0002"]);
});

test.each([
  "~~/public/logo.svg",
  "@@/public/logo.svg",
  "~/../public/logo.svg",
  "@/../public/logo.svg",
])("retains Nuxt root aliases: %s", async (source) => {
  const result = await runRuleFixture({
    rule: noPublicSrcImport,
    framework: "nuxt",
    files: { "app/main.ts": `import asset from ${JSON.stringify(source)}` },
  });
  expect(result.diagnostics.map(({ code }) => code)).toEqual(["VITE0002"]);
});

test.each(["~/public/logo.svg", "@/public/logo.svg"])(
  "keeps Nuxt app source folders separate from the root public directory: %s",
  async (source) => {
    const result = await runRuleFixture({
      rule: noPublicSrcImport,
      framework: "nuxt",
      files: { "app/main.ts": `import asset from ${JSON.stringify(source)}` },
    });
    expect(result.diagnostics).toEqual([]);
  },
);

test("bundles a dependency named public through the Vite Plugin Surface", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-public-package-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "node_modules/@acme/public"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ type: "module", dependencies: { "@acme/public": "1.0.0" } }),
    );
    await writeFile(
      join(root, "node_modules/@acme/public/package.json"),
      JSON.stringify({
        name: "@acme/public",
        version: "1.0.0",
        exports: { "./logo.svg": "./logo.svg" },
      }),
    );
    await writeFile(
      join(root, "node_modules/@acme/public/logo.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10" /></svg>',
    );
    await writeFile(join(root, "index.html"), '<script type="module" src="/src/main.ts"></script>');
    await writeFile(
      join(root, "src/main.ts"),
      "import logo from '@acme/public/logo.svg'; document.body.innerHTML = logo",
    );
    const result = await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [
        doctor({ rules: noPublicSrcImport.meta.id, mode: "error", maxWarnings: 0, cache: false }),
      ],
      build: { write: false, assetsInlineLimit: 0 },
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) =>
      "output" in item ? item.output : [],
    );
    expect(
      outputs.filter((item) => item.type === "asset" && item.fileName.endsWith(".svg")),
    ).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
