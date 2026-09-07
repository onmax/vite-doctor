import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  verifyExports();
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
  process.stdout.write(
    `Packed Doctor CLI checks passed on ${process.platform}, Node ${process.versions.node}.\n`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function verifyDoctor(args, expectedStatuses = [0], expectedCode) {
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
  if (report.project?.framework !== "nuxt") {
    throw new Error(`Expected a Nuxt Doctor Run, received: ${reportLine}`);
  }
  if (expectedCode) {
    assert.equal(report.status, "findings");
    assert.ok(report.diagnostics.some((diagnostic) => diagnostic.code === expectedCode));
  } else {
    assert.equal(report.status, "clean");
    assert.deepEqual(report.diagnostics, []);
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
      'doctor({ config: defineDoctorConfig({ extends: ["vite/recommended"] }), extensions: [defineDoctorExtension({ name: "consumer", setup() {} })] });\n',
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
