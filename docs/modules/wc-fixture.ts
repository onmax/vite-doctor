import { defineNuxtModule, createResolver } from "@nuxt/kit";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "pathe";
import { build as esbuild } from "esbuild";

const require_ = createRequire(import.meta.url);
const BINARY_EXTS = new Set([".wasm", ".node"]);

interface FixtureEntry {
  contents: string;
  encoding?: "base64";
}

interface WcFixtureNuxt {
  options: {
    buildDir: string;
    nitro?: {
      publicAssets?: Array<{ dir: string; baseURL: string }>;
    };
  };
  hook(name: "build:done", cb: () => Promise<void>): void;
}

async function walk(dir: string, baseDir = dir): Promise<Record<string, FixtureEntry>> {
  const out: Record<string, FixtureEntry> = {};
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) Object.assign(out, await walk(full, baseDir));
    else if (e.isFile()) {
      const rel = relative(baseDir, full);
      const ext = "." + rel.split(".").pop();
      const buf = await readFile(full);
      if (BINARY_EXTS.has(ext) || buf.includes(0)) {
        out[rel] = { contents: buf.toString("base64"), encoding: "base64" };
      } else {
        out[rel] = { contents: buf.toString("utf8") };
      }
    }
  }
  return out;
}

function resolvePackageRoot(name: string, from: string): string {
  const pkgJson = require_.resolve(`${name}/package.json`, { paths: [from] });
  return dirname(pkgJson);
}

async function packPackage(
  name: string,
  from: string,
  mountAt: string,
): Promise<Record<string, FixtureEntry>> {
  const root = resolvePackageRoot(name, from);
  const files = await walk(root, root);
  const out: Record<string, FixtureEntry> = {};
  for (const [p, e] of Object.entries(files)) out[`${mountAt}/${p}`] = e;
  return out;
}

const CONSOLIDATE_EXTERNALS = [
  "velocityjs",
  "dustjs-linkedin",
  "atpl",
  "liquor",
  "twig",
  "ejs",
  "eco",
  "jazz",
  "jqtpl",
  "hamljs",
  "hamlet",
  "whiskers",
  "haml-coffee",
  "hogan.js",
  "templayed",
  "handlebars",
  "underscore",
  "lodash",
  "pug",
  "then-pug",
  "qejs",
  "walrus",
  "mustache",
  "just",
  "ect",
  "mote",
  "toffee",
  "dot",
  "bracket-template",
  "ractive",
  "nunjucks",
  "htmling",
  "babel-core",
  "@babel/core",
  "plates",
  "react-dom/server",
  "react",
  "vash",
  "slm",
  "marko",
  "teacup/lib/express",
  "coffee-script",
  "squirrelly",
  "twing",
  "arc-templates/dist/es5",
  "tinyliquid",
  "liquid-node",
];

async function bundleCli(entry: string): Promise<string> {
  const result = await esbuild({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    write: false,
    external: ["oxc-parser", ...CONSOLIDATE_EXTERNALS],
    banner: {
      js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
    },
    loader: { ".node": "empty", ".wasm": "empty" },
    legalComments: "none",
    minify: true,
  });
  return result.outputFiles[0]!.text;
}

function renderFixture(
  name: "vue" | "nuxt",
  bundle: string,
  oxc: Record<string, FixtureEntry>,
): Record<string, FixtureEntry> {
  const pkg = JSON.stringify({
    name: `${name}-doctor`,
    version: "0.0.0",
    type: "module",
    bin: { [`${name}-doctor`]: "./bin.mjs" },
  });
  return {
    "/package.json": { contents: '{"name":"doctor-demo","private":true,"type":"module"}' },
    [`/node_modules/${name}-doctor/package.json`]: { contents: pkg },
    [`/node_modules/${name}-doctor/bin.mjs`]: { contents: bundle },
    ...oxc,
  };
}

export default defineNuxtModule({
  meta: { name: "wc-fixture", configKey: "wcFixture" },
  async setup(_options: unknown, nuxt: WcFixtureNuxt) {
    const resolver = createResolver(import.meta.url);
    const docsRoot = resolver.resolve("..");
    const repoRoot = resolver.resolve("../..");

    const vueEntry = join(repoRoot, "packages/vue/src/cli.ts");
    const nuxtEntry = join(repoRoot, "packages/nuxt/src/bin.ts");

    const [vueBundle, nuxtBundle] = await Promise.all([bundleCli(vueEntry), bundleCli(nuxtEntry)]);

    const oxcPackages = await Promise.all([
      packPackage("oxc-parser", docsRoot, "/node_modules/oxc-parser"),
      packPackage(
        "@oxc-parser/binding-wasm32-wasi",
        docsRoot,
        "/node_modules/@oxc-parser/binding-wasm32-wasi",
      ),
      packPackage("@oxc-project/types", docsRoot, "/node_modules/@oxc-project/types"),
    ]).catch(() => []);
    const oxc = Object.assign({}, ...oxcPackages);
    const demoRaw = await walk(join(docsRoot, "examples/demo-nuxt-app")).catch(() => ({}));
    const demoFiles: Record<string, FixtureEntry> = {};
    for (const [p, e] of Object.entries(demoRaw)) demoFiles[`/${p}`] = e;

    const vueFixture = renderFixture("vue", vueBundle, oxc);
    const nuxtFixture = renderFixture("nuxt", nuxtBundle, oxc);

    const fixtureDir = join(docsRoot, ".wc-fixtures");
    await mkdir(fixtureDir, { recursive: true });
    await Promise.all([
      writeFile(
        join(fixtureDir, "vue.json"),
        JSON.stringify({ fixture: vueFixture, binPath: "/node_modules/vue-doctor/bin.mjs" }),
      ),
      writeFile(
        join(fixtureDir, "nuxt.json"),
        JSON.stringify({ fixture: nuxtFixture, binPath: "/node_modules/nuxt-doctor/bin.mjs" }),
      ),
      writeFile(join(fixtureDir, "demo.json"), JSON.stringify({ demo: demoFiles })),
    ]);

    nuxt.options.nitro ||= {};
    nuxt.options.nitro.publicAssets ||= [];
    nuxt.options.nitro.publicAssets.push({ dir: fixtureDir, baseURL: "/__wc-fixtures/" });

    nuxt.hook("build:done", async () => {
      await cp(fixtureDir, join(docsRoot, ".output/public/__wc-fixtures"), { recursive: true });
    });
  },
});
