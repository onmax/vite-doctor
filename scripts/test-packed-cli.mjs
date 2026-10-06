import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDirectory = join(homedir(), ".cache");
mkdirSync(cacheDirectory, { recursive: true });
const temporary = mkdtempSync(join(cacheDirectory, "vite-doctor-pack-"));
const packDirectory = join(temporary, "pack");
const fixture = join(temporary, "fixture with spaces");
const env = { ...process.env, CI: "1", NO_COLOR: "1" };
const packageManager = process.env.npm_execpath;
const pnpmCommand = packageManager ? process.execPath : "pnpm";
const pnpmArgs = (args) => (packageManager ? [packageManager, ...args] : args);

try {
  mkdirSync(packDirectory);
  mkdirSync(fixture);
  execFileSync(pnpmCommand, pnpmArgs(["pack", "--pack-destination", packDirectory]), {
    cwd: root,
    env,
    stdio: "pipe",
  });
  const archive = readdirSync(packDirectory).find((file) => file.endsWith(".tgz"));
  if (!archive) throw new Error("pnpm pack did not produce a tarball.");
  const tarball = join(packDirectory, archive);
  const nuxt = JSON.parse(readFileSync(join(root, "node_modules/nuxt/package.json"), "utf8"));
  writeFileSync(
    join(temporary, "package.json"),
    `${JSON.stringify({ private: true, dependencies: { nuxt: nuxt.version, "vite-doctor": `file:${tarball}` } }, null, 2)}\n`,
  );
  execFileSync(pnpmCommand, pnpmArgs(["install", "--ignore-scripts", "--prefer-offline"]), {
    cwd: temporary,
    env,
    stdio: "pipe",
  });
  execFileSync(process.execPath, ["--input-type=module", "-"], {
    cwd: temporary,
    env,
    input: 'await import("vite-doctor/cli");\n',
    stdio: "pipe",
  });
  verifyExports();
  verifyLightweightEntries();
  verifyServeRunWorker();
  writeFileSync(
    join(fixture, "package.json"),
    `${JSON.stringify({ private: true, dependencies: { nuxt: nuxt.version } }, null, 2)}\n`,
    { flag: "wx" },
  );
  writeFileSync(join(fixture, "nuxt.config.ts"), "export default defineNuxtConfig({})\n");

  verifyDoctor(["exec", "vite-doctor", fixture, "--format", "agent", "--no-cache"]);
  verifyDoctor(["exec", "nuxt-doctor", fixture, "--format", "agent", "--no-cache"]);
  verifyDoctor(["nuxt", "doctor", fixture, "--format", "agent", "--no-cache"]);
  mkdirSync(join(fixture, "app/pages"), { recursive: true });
  writeFileSync(
    join(fixture, "app/pages/index.vue"),
    "<script setup>const width = window.innerWidth</script>\n<template><p>{{ width }}</p></template>\n",
  );
  const findingArgs = [
    fixture,
    "--rules",
    "nuxt/hydration/no-browser-global-in-universal-code",
    "--format",
    "agent",
    "--no-cache",
  ];
  verifyDoctor(["exec", "vite-doctor", ...findingArgs], [1], "NUXT0029");
  verifyDoctor(["exec", "nuxt-doctor", ...findingArgs], [1], "NUXT0029");
  verifyDoctor(["nuxt", "doctor", ...findingArgs], [0, 1], "NUXT0029");
  const library = join(temporary, "library with spaces");
  mkdirSync(join(library, "dist"), { recursive: true });
  writeFileSync(
    join(library, "package.json"),
    JSON.stringify({
      name: "packed-library-fixture",
      main: "dist/index.js",
      types: "dist/index.d.ts",
      peerDependencies: { "optional-peer": "*" },
      peerDependenciesMeta: { "optional-peer": { optional: true } },
    }),
  );
  writeFileSync(
    join(library, "dist/index.js"),
    'import "optional-peer"; import "phantom-runtime";',
  );
  writeFileSync(
    join(library, "dist/index.d.ts"),
    'export type Value = import("phantom-types").Value;',
  );
  const libraryArgs = [
    "exec",
    "vite-doctor",
    library,
    "--framework",
    "vite",
    "--format",
    "agent",
    "--no-cache",
  ];
  verifyDoctor(libraryArgs, [0], undefined, "vite");
  const packageReport = verifyDoctor(
    [...libraryArgs, "--extends", "package/recommended", "--max-warnings", "0"],
    [1],
    "PKG0001",
    "vite",
  );
  assert.deepEqual(packageReport.diagnostics.map((item) => item.code).sort(), [
    "PKG0001",
    "PKG0002",
    "PKG0003",
  ]);
  assert.match(packageReport.commands.verify, /--extends package\/recommended/);
  process.stdout.write(
    `Packed Doctor CLI checks passed on ${process.platform}, Node ${process.versions.node}.\n`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function verifyDoctor(args, expectedStatuses = [0], expectedCode, expectedFramework = "nuxt") {
  const result = spawnSync(pnpmCommand, pnpmArgs(args), {
    cwd: temporary,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  const output = result.stdout;
  assert.ok(
    expectedStatuses.includes(result.status),
    `Unexpected exit ${result.status} from pnpm ${args.join(" ")}: ${output}\n${result.stderr}`,
  );
  assert.doesNotMatch(result.stderr, /\n\s+at .+\(.+:\d+:\d+\)/);
  const reportLine = output
    .split("\n")
    .find((line) => line.startsWith('{"schema":"vite-doctor.agent/v1"'));
  if (!reportLine) throw new Error(`Doctor report missing from: ${output}`);
  const report = JSON.parse(reportLine);
  if (report.project?.framework !== expectedFramework) {
    throw new Error(`Expected a ${expectedFramework} Doctor Run, received: ${reportLine}`);
  }
  if (expectedCode) {
    assert.equal(report.status, "findings");
    assert.ok(report.diagnostics.some((diagnostic) => diagnostic.code === expectedCode));
  } else {
    assert.equal(report.status, "clean");
    assert.deepEqual(report.diagnostics, []);
  }
  return report;
}

function verifyLightweightEntries() {
  const analyzers = [
    "typescript",
    "eslint",
    "eslint-plugin-vue",
    "vue-eslint-parser",
    "@typescript-eslint/parser",
    "@shadcn/lint",
  ];
  const hooks = join(temporary, "record-analyzers.mjs");
  writeFileSync(
    hooks,
    `import { registerHooks } from "node:module";
import { writeFileSync } from "node:fs";
const analyzers = ${JSON.stringify(analyzers)};
const loaded = new Set();
registerHooks({
  resolve(specifier, context, next) {
    const result = next(specifier, context);
    for (const name of analyzers) if (result.url.includes(\`/node_modules/\${name}/\`)) loaded.add(name);
    return result;
  },
});
process.on("exit", () => writeFileSync(process.env.DOCTOR_LOADED_ANALYZERS, JSON.stringify([...loaded])));
`,
  );
  const evaluate = (source) => ["--input-type=module", "-e", source];
  const probes = [
    {
      name: "the analyzer recorder",
      args: evaluate(
        'import { createRequire } from "node:module"; createRequire(import.meta.resolve("vite-doctor/package.json"))("typescript");',
      ),
      expected: ["typescript"],
    },
    { name: "vite-doctor/plugin", args: evaluate('await import("vite-doctor/plugin");') },
    { name: "vite-doctor", args: evaluate('await import("vite-doctor");') },
    {
      name: "vite-doctor --version",
      args: [join(temporary, "node_modules/vite-doctor/dist/cli.mjs"), "--version"],
    },
    ...["--version", "-v", "--help", "--invalid"].map((flag) => ({
      name: `nuxt-doctor ${flag}`,
      args: [join(temporary, "node_modules/vite-doctor/dist/nuxt-cli.mjs"), flag],
      status: flag === "--invalid" ? 2 : 0,
    })),
  ];
  for (const { name, args, expected = [], status = 0 } of probes) {
    const record = join(temporary, "loaded-analyzers.json");
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(hooks).href, ...args], {
      cwd: temporary,
      env: { ...env, DOCTOR_LOADED_ANALYZERS: record },
      encoding: "utf8",
      stdio: "pipe",
    });
    if (result.error) throw result.error;
    assert.equal(result.status, status, `${name}: ${result.stdout}\n${result.stderr}`);
    assert.deepEqual(
      JSON.parse(readFileSync(record, "utf8")),
      expected,
      `${name} loaded unexpected analyzers before a Doctor Run.`,
    );
  }
}

function verifyServeRunWorker() {
  const project = join(temporary, "serve fixture");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ type: "module", dependencies: { vue: "^3.5.0" } }),
  );
  writeFileSync(
    join(project, "src/App.vue"),
    '<script setup lang="ts">\nconst count: number = 0;\n</script>\n<template><button>{{ count }}</button></template>\n',
  );
  const hooks = join(temporary, "record-main-thread-analyzers.mjs");
  writeFileSync(
    hooks,
    `import { registerHooks } from "node:module";
import { writeFileSync } from "node:fs";
import { isMainThread } from "node:worker_threads";
if (isMainThread) {
  const loaded = new Set();
  registerHooks({
    resolve(specifier, context, next) {
      const result = next(specifier, context);
      for (const name of ["typescript", "oxc-parser", "eslint-plugin-vue", "vue-eslint-parser"])
        if (result.url.includes(\`/node_modules/\${name}/\`)) loaded.add(name);
      return result;
    },
  });
  process.on("exit", () => writeFileSync(process.env.DOCTOR_LOADED_ANALYZERS, JSON.stringify([...loaded])));
}
`,
  );
  const script = join(temporary, "serve-run.mjs");
  writeFileSync(
    script,
    `import { createServer } from ${JSON.stringify(import.meta.resolve("vite"))};
import { doctor } from "vite-doctor/plugin";
const [mode, root] = process.argv.slice(2);
const { promise: reported, resolve } = Promise.withResolvers();
const log = (message) => { if (message.includes("Summary")) resolve(message); };
const server = await createServer({
  root,
  configFile: false,
  customLogger: { info: log, warn: log, warnOnce: log, error: log, clearScreen() {}, hasErrorLogged: () => false, hasWarned: false },
  server: { port: 0, ws: false, watch: null },
  optimizeDeps: { noDiscovery: true },
  plugins: [doctor({ run: "serve", mode: "warn", cache: false, extensions: mode === "main-thread" ? [{ name: "packed/main-thread", setup() {} }] : [] })],
});
await server.listen();
process.stdout.write(await reported);
await server.close();
`,
  );
  for (const mode of ["worker", "main-thread"]) {
    const record = join(temporary, `serve-${mode}-analyzers.json`);
    const result = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(hooks).href, script, mode, project],
      {
        cwd: temporary,
        env: { ...env, DOCTOR_LOADED_ANALYZERS: record },
        encoding: "utf8",
        stdio: "pipe",
        timeout: 60_000,
      },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `serve ${mode}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /VUE0022/, `serve ${mode} did not log the Doctor report.`);
    const analyzers = JSON.parse(readFileSync(record, "utf8"));
    if (mode === "worker") {
      assert.deepEqual(
        analyzers,
        [],
        "A serve-mode Doctor Run loaded analyzers on the main thread.",
      );
    } else {
      assert.notDeepEqual(analyzers, [], "The main-thread control run loaded no analyzers.");
    }
  }
}

function verifyExports() {
  const manifest = JSON.parse(
    readFileSync(join(temporary, "node_modules/vite-doctor/package.json"), "utf8"),
  );
  const subpaths = Object.keys(manifest.exports).filter((subpath) => subpath !== "./package.json");
  const specifiers = subpaths.map((subpath) =>
    subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`,
  );
  const runtimeImports = specifiers
    .filter((specifier) => specifier !== `${manifest.name}/cli`)
    .map((specifier) => `await import(${JSON.stringify(specifier)});`)
    .join("\n");
  writeFileSync(join(temporary, "imports.mjs"), `${runtimeImports}\n`);
  execFileSync(process.execPath, [join(temporary, "imports.mjs")], {
    cwd: temporary,
    env,
    stdio: "inherit",
  });

  const typeImports = specifiers.map(
    (specifier, index) =>
      `import * as entry${index} from ${JSON.stringify(specifier)}; export { entry${index} };`,
  );
  writeFileSync(
    join(temporary, "consumer.mts"),
    `${typeImports.join("\n")}\n` +
      'import { doctor, defineDoctorConfig } from "vite-doctor";\n' +
      'import { defineDoctorExtension } from "vite-doctor/extension";\n' +
      'doctor({ config: defineDoctorConfig({ extends: ["vite/recommended"] }), extensions: [defineDoctorExtension({ name: "consumer", setup() {} })] });\n' +
      'import type { NuxtHooks } from "nuxt/schema";\n' +
      'import type { DoctorPluginApi } from "vite-doctor/extension";\n' +
      'export const extendExtensions: NuxtHooks["doctor:extendExtensions"] = (entries) => { entries.push("/consumer/doctor.mjs"); };\n' +
      'export const api = { doctor: { extensions: [async () => defineDoctorExtension({ name: "lazy" })] } satisfies DoctorPluginApi };\n',
  );
  for (const [module, moduleResolution] of [
    ["NodeNext", "NodeNext"],
    ["ESNext", "Bundler"],
  ]) {
    writeFileSync(
      join(temporary, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module,
          moduleResolution,
          target: "ESNext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        files: ["consumer.mts"],
      }),
    );
    execFileSync(
      process.execPath,
      [join(root, "node_modules/typescript/bin/tsc"), "-p", join(temporary, "tsconfig.json")],
      {
        cwd: temporary,
        env,
        stdio: "inherit",
      },
    );
  }
  process.stdout.write(
    `Verified ${specifiers.length} packed exports with NodeNext and Bundler declarations.\n`,
  );
}
