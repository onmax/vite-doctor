import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
// Nuxt 4.6 is the first release whose CLI exits with a host command's status, so `nuxt doctor` can fail CI.
const nuxtVersion = "4.6.4";
// The Vite a project such as a Nuxt app installs next to Vite+, which brings its own copy of Vite.
const viteVersion = "8.3.8";
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
  writeFileSync(
    join(temporary, "package.json"),
    `${JSON.stringify({ private: true, dependencies: { nuxt: nuxtVersion, "vite-doctor": `file:${tarball}` } }, null, 2)}\n`,
  );
  execFileSync(pnpmCommand, pnpmArgs(["install", "--ignore-scripts", "--prefer-offline"]), {
    cwd: temporary,
    env,
    stdio: "pipe",
  });
  verifyCliImport();
  verifyExports();
  verifyLightweightEntries();
  verifyServeRunWorker();
  verifyDoctorProcess();
  writeFileSync(
    join(fixture, "package.json"),
    `${JSON.stringify({ private: true, dependencies: { nuxt: nuxtVersion } }, null, 2)}\n`,
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
  verifyDoctor(["nuxt", "doctor", ...findingArgs], [1], "NUXT0029");
  const migrate = spawnSync(
    pnpmCommand,
    pnpmArgs(["nuxt", "doctor", "migrate", fixture, "--not-a-doctor-flag"]),
    { cwd: temporary, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.equal(migrate.status, 2, `${migrate.stdout}\n${migrate.stderr}`);
  verifyNpmBins(archive, findingArgs);
  verifyViteConfigTypes(archive);
  const library = join(temporary, "library with spaces");
  mkdirSync(join(library, "dist"), { recursive: true });
  writeFileSync(
    join(library, "package.json"),
    JSON.stringify({
      name: "packed-library-fixture",
      main: "dist/index.js",
      types: "dist/index.d.ts",
      peerDependencies: { "optional-peer": "*", "lazy-peer": "*" },
      peerDependenciesMeta: {
        "optional-peer": { optional: true },
        "lazy-peer": { optional: true },
      },
    }),
  );
  writeFileSync(
    join(library, "dist/index.js"),
    'import "optional-peer"; import "phantom-runtime"; export const load = () => import("lazy-peer");',
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
    "PKG0004",
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
  return verifyReport(
    result,
    `pnpm ${args.join(" ")}`,
    expectedStatuses,
    expectedCode,
    expectedFramework,
  );
}

function verifyReport(result, label, expectedStatuses, expectedCode, expectedFramework = "nuxt") {
  if (result.error) throw result.error;
  const output = result.stdout;
  assert.ok(
    expectedStatuses.includes(result.status),
    `Unexpected exit ${result.status} from ${label}: ${output}\n${result.stderr}`,
  );
  assert.doesNotMatch(result.stderr, /\n\s+at .+\(.+:\d+:\d+\)/);
  const reportLine = output
    .split("\n")
    .find((line) => line.startsWith('{"schema":"vite-doctor.agent/v2"'));
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

// Importing the `vite-doctor/cli` module from a script file must not start a Doctor Run.
function verifyCliImport() {
  const script = join(temporary, "import-cli.mjs");
  writeFileSync(
    script,
    'const cli = await import("vite-doctor/cli");\nif (typeof cli.main !== "function") process.exit(3);\n',
  );
  const result = spawnSync(process.execPath, [script, "--version"], {
    cwd: temporary,
    env,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `import vite-doctor/cli: ${result.stdout}\n${result.stderr}`);
  assert.equal(result.stdout, "", "Importing vite-doctor/cli started the CLI.");
}

// npm links bins into node_modules/.bin as symlinks (POSIX) or cmd shims (Windows), unlike pnpm's
// shell shims, so the bins must recognise themselves when started through either.
function verifyNpmBins(archive, findingArgs) {
  const consumer = join(temporary, "npm consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, dependencies: { "vite-doctor": `file:../pack/${archive}` } }),
  );
  const npmEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.toLowerCase().startsWith("npm_")),
  );
  const windows = process.platform === "win32";
  const install = spawnSync(
    windows ? "npm install --ignore-scripts --prefer-offline --no-audit --no-fund" : "npm",
    windows ? [] : ["install", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"],
    { cwd: consumer, env: npmEnv, encoding: "utf8", stdio: "pipe", shell: windows },
  );
  if (install.error) throw install.error;
  assert.equal(install.status, 0, `npm install: ${install.stdout}\n${install.stderr}`);
  const { version } = JSON.parse(
    readFileSync(join(consumer, "node_modules/vite-doctor/package.json"), "utf8"),
  );
  const bin = join(consumer, "node_modules/.bin");
  for (const name of ["vite-doctor", "nuxt-doctor"]) {
    if (windows) {
      const shim = spawnSync(`node_modules\\.bin\\${name}.cmd --version`, {
        cwd: consumer,
        env,
        encoding: "utf8",
        stdio: "pipe",
        shell: true,
      });
      if (shim.error) throw shim.error;
      assert.equal(shim.status, 0, `npm ${name}.cmd --version: ${shim.stdout}\n${shim.stderr}`);
      assert.equal(shim.stdout.trim(), version, `npm ${name}.cmd --version`);
      continue;
    }
    const link = join(bin, name);
    assert.ok(lstatSync(link).isSymbolicLink(), `npm did not link ${name} as a symlink.`);
    const viaNode = spawnSync(process.execPath, [link, "--version"], {
      cwd: consumer,
      env,
      encoding: "utf8",
      stdio: "pipe",
    });
    if (viaNode.error) throw viaNode.error;
    assert.equal(viaNode.status, 0, `node .bin/${name} --version: ${viaNode.stderr}`);
    assert.equal(viaNode.stdout.trim(), version, `node .bin/${name} --version`);
    const direct = spawnSync(link, findingArgs, {
      cwd: consumer,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    verifyReport(direct, `.bin/${name} (npm symlink)`, [1], "NUXT0029");
  }
}

// This repository aliases vite to @voidzero-dev/vite-plus-core, so only a separate install shows
// how a consumer's TypeScript resolves the `doctor` key under each defineConfig().
function verifyViteConfigTypes(archive) {
  const vitePlus = JSON.parse(
    readFileSync(join(root, "node_modules/vite-plus/package.json"), "utf8"),
  );
  const core = `npm:@voidzero-dev/vite-plus-core@${vitePlus.version}`;
  const layouts = [
    // vite-plus's defineConfig is typed against its own copy of Vite. When that copy is only
    // installed under the alias `vite` inside vite-plus, no package can augment it.
    { name: "Vite next to Vite+", vite: viteVersion, errors: ["vite-plus.config.ts TS2353"] },
    { name: "Vite+ overriding vite", vite: core, overrides: { vite: core }, errors: [] },
  ];
  for (const layout of layouts) {
    const consumer = join(temporary, `${layout.name} consumer`);
    mkdirSync(consumer);
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: {
          vite: layout.vite,
          "vite-plus": vitePlus.version,
          vitest: vitePlus.dependencies.vitest,
          "vite-doctor": `file:../pack/${archive}`,
        },
      }),
    );
    if (layout.overrides) {
      writeFileSync(
        join(consumer, "pnpm-workspace.yaml"),
        `overrides:\n${Object.entries(layout.overrides)
          .map(([name, spec]) => `  ${name}: ${JSON.stringify(spec)}\n`)
          .join("")}`,
      );
    }
    execFileSync(pnpmCommand, pnpmArgs(["install", "--ignore-scripts", "--prefer-offline"]), {
      cwd: consumer,
      env,
      stdio: "pipe",
    });
    const files = { vite: "vite", "vite-plus": "vite-plus", "vitest/config": "vitest" };
    for (const [module, name] of Object.entries(files)) {
      writeFileSync(
        join(consumer, `${name}.config.ts`),
        `import { defineConfig } from ${JSON.stringify(module)};\nimport { defineDoctorConfig } from "vite-doctor";\n\nexport default defineConfig({\n  doctor: defineDoctorConfig({ rules: { "vite/define/no-secret-define": "off" } }),\n});\n`,
      );
    }
    writeFileSync(
      join(consumer, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          target: "ESNext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        files: Object.values(files).map((name) => `${name}.config.ts`),
      }),
    );
    const result = spawnSync(
      process.execPath,
      [join(root, "node_modules/typescript/bin/tsc"), "-p", join(consumer, "tsconfig.json")],
      { cwd: consumer, env, encoding: "utf8", stdio: "pipe" },
    );
    if (result.error) throw result.error;
    const errors = [...result.stdout.matchAll(/^(\S+?)\(\d+,\d+\): error (TS\d+)/gm)].map(
      ([, file, code]) => `${file} ${code}`,
    );
    assert.deepEqual(errors, layout.errors, `${layout.name}: ${result.stdout}${result.stderr}`);
    assert.equal(result.status, layout.errors.length ? 2 : 0, `${layout.name}: ${result.stdout}`);
  }
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
    ...["bin.mjs", "cli.mjs"].map((file) => ({
      name: `node dist/${file} --version`,
      args: [join(temporary, "node_modules/vite-doctor/dist", file), "--version"],
    })),
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
    JSON.stringify({ type: "module", dependencies: { pinia: "^3.0.0", vue: "^3.5.0" } }),
  );
  writeFileSync(
    join(project, "src/App.vue"),
    '<script setup lang="ts">\nconst count: number = 0;\n</script>\n<template><button>{{ count }}</button></template>\n',
  );
  writeFileSync(
    join(project, "src/cart.ts"),
    "import { defineStore } from 'pinia'; export const useCartStore = defineStore('cart', { state: () => ({ count: 0 }) });\n",
  );
  writeFileSync(
    join(project, "src/entry.ts"),
    "import { useCartStore } from './cart'; export const cart = useCartStore();\n",
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
    assert.match(result.stdout, /PINIA0006/, `serve ${mode} did not resolve the store import.`);
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

function verifyDoctorProcess() {
  const project = join(temporary, "process fixture");
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ dependencies: { vite: "^7.0.0" } }),
  );
  writeFileSync(
    join(project, "vite.config.ts"),
    "export default { define: { SECRET_KEY: JSON.stringify('secret') } }\n",
  );
  const cli = join(temporary, "node_modules/vite-doctor/dist/bin.mjs");
  const run = (args, extraEnv = {}) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: project,
      env: { ...env, VITE_DOCTOR_SERVER_IDLE_MS: "120000", ...extraEnv },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const status = () => JSON.parse(run(["server", "status", "--format", "json"]).stdout);
  try {
    for (const format of ["agent", "json", "text", "sarif"]) {
      const direct = run([".", "--format", format]);
      const served = run([".", "--format", format, "--server"]);
      assert.deepEqual(served, direct, `Doctor process output differs for --format ${format}`);
      assert.equal(direct.status, 1);
    }
    const running = status();
    assert.equal(running.running, true, "The Doctor process is not running after --server.");
    assert.equal(running.current, true);
    assert.equal(running.activity.runs, 4);
    run(["."], { VITE_DOCTOR_SERVER: "1" });
    assert.equal(status().activity.pid, running.activity.pid, "The Doctor process was not reused.");
    assert.equal(status().activity.runs, 5);
    assert.match(run(["server", "stop"]).stdout, /Doctor process \d+ stopped/);
    assert.equal(status().running, false);
  } finally {
    run(["server", "stop"]);
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
