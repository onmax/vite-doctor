import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "pathe";
import { afterEach, expect, test } from "vite-plus/test";
import {
  allDiagnostics,
  cacheStatus,
  createRule,
  defineDoctorExtension,
  defineRulePack,
  detectProject,
  runDoctor,
  type DoctorRule,
  type DoctorRunResult,
} from "../../src/core/index.ts";
import {
  selectScanFiles,
  selectSourceInventory,
} from "../../src/core/internal/source-inventory.ts";
import { FINGERPRINT_SCHEME } from "../../src/core/diagnostic-constants.ts";
import { runProjectFixture } from "../../src/testkit.ts";

function todoRule(id: string, includeTestFiles?: boolean): DoctorRule {
  return createRule({
    meta: {
      id,
      title: "TODO comment",
      category: "fixture",
      severity: "warn",
      ...(includeTestFiles === undefined ? {} : { includeTestFiles }),
    },
    create(ctx) {
      for (const match of ctx.file.text.matchAll(/TODO/g))
        ctx.report(allDiagnostics.DOC9999({ why: "A TODO.", fix: "Finish it." }), {
          range: ctx.range(match.index, match.index + 4),
        });
    },
  });
}

const withTests = todoRule("fixture/todo-with-tests", true);
const sourceOnly = todoRule("fixture/plain-todo");

const files = {
  "src/app.ts": "export const app = 1; // TODO\n",
  "src/foo.test.ts": "// TODO\nexport {};\n",
  "src/foo.spec.vue": '<script setup lang="ts">\n// TODO\n</script>\n',
  "tests/bar.ts": "// TODO\nexport {};\n",
  "src/__tests__/baz.ts": "// TODO\nexport {};\n",
  "tests/fixtures/input.ts": "// TODO\nexport {};\n",
  "src/__snapshots__/foo.test.ts.snap.ts": "// TODO\n",
  "test-d/types.ts": "// TODO\nexport {};\n",
  "node_modules/pkg/index.test.ts": "// TODO\n",
};

const reported = (result: DoctorRunResult) =>
  result.diagnostics
    .map((diagnostic) => `${diagnostic.ruleId} ${relative(result.root, diagnostic.file)}`)
    .sort();

test("only a Rule that declares includeTestFiles runs on authored test code", async () => {
  const result = await runProjectFixture({ files, rules: [withTests, sourceOnly] });
  expect(reported(result)).toEqual([
    "fixture/plain-todo src/app.ts",
    "fixture/todo-with-tests src/__tests__/baz.ts",
    "fixture/todo-with-tests src/app.ts",
    "fixture/todo-with-tests src/foo.spec.vue",
    "fixture/todo-with-tests src/foo.test.ts",
    "fixture/todo-with-tests tests/bar.ts",
  ]);
  expect(result.scope).toEqual({ mode: "all", files: 5 });
});

test("a run without a Rule that includes test files analyzes the same files as before", async () => {
  for (const rules of [[sourceOnly], [todoRule("fixture/todo-off", false)]]) {
    const result = await runProjectFixture({ files, rules });
    expect(reported(result).map((line) => line.split(" ")[1])).toEqual(["src/app.ts"]);
    expect(result.scope).toEqual({ mode: "all", files: 1 });
  }
});

test("the source inventory selects test files only on request", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-test-files-"));
  try {
    for (const [path, text] of Object.entries(files)) write(root, path, text);
    write(root, "package.json", JSON.stringify({ dependencies: { vue: "^3.5.0" } }));
    const project = await detectProject(root, "vue");
    const before = await selectScanFiles(root, {}, {}, project);
    const plain = await selectSourceInventory(root, {}, {}, project);
    expect(plain.files).toEqual(before);
    expect(plain.testFiles).toEqual([]);
    const requested = await selectSourceInventory(root, {}, {}, project, { testFiles: true });
    expect(requested.files).toEqual(before);
    expect(requested.testFiles.map((file) => file.displayPath).sort()).toEqual([
      "src/__tests__/baz.ts",
      "src/foo.spec.vue",
      "src/foo.test.ts",
      "tests/bar.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config.exclude, overrides, and inline directives apply to test files", async () => {
  const excluded = await runProjectFixture({
    files,
    rules: [withTests],
    config: { exclude: ["tests/**", "**/*.spec.vue"] },
  });
  expect(reported(excluded)).toEqual([
    "fixture/todo-with-tests src/__tests__/baz.ts",
    "fixture/todo-with-tests src/app.ts",
    "fixture/todo-with-tests src/foo.test.ts",
  ]);

  const overridden = await runProjectFixture({
    files: {
      ...files,
      "tests/bar.ts":
        "// doctor-disable-next-line fixture/todo-with-tests -- fixture\nexport const bar = 1; // TODO\n",
    },
    rules: [withTests],
    config: {
      overrides: [{ files: ["**/*.test.ts"], rules: { "fixture/todo-with-tests": "off" } }],
    },
  });
  expect(reported(overridden)).toEqual([
    "fixture/todo-with-tests src/__tests__/baz.ts",
    "fixture/todo-with-tests src/app.ts",
    "fixture/todo-with-tests src/foo.spec.vue",
  ]);
});

test("a test file no opted-in Rule runs on is not parsed or counted", async () => {
  const broken = {
    "src/app.ts": "export const app = 1;\n",
    "tests/broken.ts": "export const = ;\n",
  };
  const analyzed = await runProjectFixture({ files: broken, rules: [withTests] });
  expect(
    analyzed.project.evidenceGaps?.flatMap((gap) =>
      gap.files.map((file) => relative(analyzed.root, file)),
    ),
  ).toEqual(["tests/broken.ts"]);
  expect(analyzed.scope.files).toBe(2);

  const skipped = await runProjectFixture({
    files: broken,
    rules: [withTests],
    config: { overrides: [{ files: ["tests/**"], rules: { [withTests.meta.id]: "off" } }] },
  });
  expect(skipped.project.evidenceGaps).toBeUndefined();
  expect(skipped.scope.files).toBe(1);
});

test("test files inside a registered Nuxt module source stay skipped", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-test-files-"));
  roots.push(root);
  write(root, "package.json", JSON.stringify({ dependencies: { nuxt: "^4.1.0" } }));
  write(root, "nuxt.config.ts", "export default {}\n");
  write(root, "modules/widget/index.ts", "export const widget = 1; // TODO\n");
  write(root, "modules/widget/tests/widget.test.ts", "// TODO\nexport {};\n");
  write(root, "tests/app.test.ts", "// TODO\nexport {};\n");
  write(
    root,
    ".nuxt/doctor.manifest.json",
    JSON.stringify({ moduleSources: [{ module: "widget", root: join(root, "modules/widget") }] }),
  );
  const result = await runDoctor({
    root,
    framework: "nuxt",
    cache: false,
    extensions: [extension],
  });
  expect(reported(result).filter((line) => line.startsWith("fixture/"))).toEqual([
    "fixture/todo-with-tests modules/widget/index.ts",
    "fixture/todo-with-tests tests/app.test.ts",
  ]);
});

test("--rules selects whether test files are analyzed", async () => {
  const result = await runProjectFixture({
    files,
    rules: [withTests, sourceOnly],
    run: { rules: "fixture/plain-todo" },
  });
  expect(reported(result)).toEqual(["fixture/plain-todo src/app.ts"]);
  expect(result.scope.files).toBe(1);
});

test("--new-only proves a baseline entry resolved in a test file only for a Rule that ran there", async () => {
  const entry = (ruleId: string) => ({ ruleId, file: "src/foo.test.ts", fingerprint: ruleId });
  const result = await runProjectFixture({
    files: {
      "src/app.ts": "export const app = 1;\n",
      "src/foo.test.ts": "export {};\n",
      "baseline.json": JSON.stringify({
        version: 2,
        fingerprintScheme: FINGERPRINT_SCHEME,
        diagnostics: [entry(withTests.meta.id), entry(sourceOnly.meta.id)],
      }),
    },
    rules: [withTests, sourceOnly],
    run: { baseline: "baseline.json", newOnly: true },
  });
  expect(result.diagnostics.map((item) => item.evidence?.map((e) => e.summary))).toEqual([
    [`${withTests.meta.id} no longer reports fingerprint ${withTests.meta.id} in src/foo.test.ts.`],
  ]);
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function git(root: string, ...args: string[]) {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function gitProject(): string {
  const root = mkdtempSync(join(tmpdir(), "doctor-test-files-"));
  roots.push(root);
  write(root, "package.json", JSON.stringify({ type: "module", dependencies: { vue: "^3.5.0" } }));
  write(root, ".gitignore", ".vite-doctor\nsrc/ignored.test.ts\n");
  write(root, "src/app.ts", "export const app = 1;\n");
  write(root, "src/foo.test.ts", "// TODO\nexport {};\n");
  write(root, "src/ignored.test.ts", "// TODO\nexport {};\n");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "-c", "user.name=Doctor", "-c", "user.email=doctor@example.test", "commit", "-qm", "a");
  return root;
}

const extension = defineDoctorExtension({
  name: "fixture",
  rulePacks: [
    defineRulePack({
      name: "fixture",
      version: "0.0.0",
      rules: [withTests],
      presets: { recommended: [withTests.meta.id] },
    }),
  ],
});

test("--changed reports changed lines of test files, and .gitignore still wins", async () => {
  const root = gitProject();
  write(root, "src/foo.test.ts", "// TODO\nexport {};\n// TODO new\n");
  const options = { root, framework: "vue" as const, extensions: [extension] };

  const full = await runDoctor({ ...options, cache: false });
  expect(full.diagnostics.map((item) => [relative(root, item.file), item.range?.line])).toEqual([
    ["src/foo.test.ts", 1],
    ["src/foo.test.ts", 3],
  ]);

  const changed = await runDoctor({ ...options, cache: false, changed: true });
  expect(changed.diagnostics.map((item) => [relative(root, item.file), item.range?.line])).toEqual([
    ["src/foo.test.ts", 3],
  ]);
  expect(changed.scope).toMatchObject({ mode: "changed", files: 1 });
});

test("the analysis cache replays results for test files", async () => {
  const root = gitProject();
  const options = { root, framework: "vue" as const, extensions: [extension], cache: true };
  const cold = await runDoctor(options);
  expect(cacheStatus(root).files).toBe(2);
  // Editing the source file rewrites the store while the test file's result is replayed.
  write(root, "src/app.ts", "export const app = 2;\n");
  const warm = await runDoctor(options);
  expect(warm.diagnostics).toEqual(cold.diagnostics);
  expect(cacheStatus(root).lastWrite).toMatchObject({
    files: 2,
    filesParsed: 1,
    ruleResultsReused: 1,
  });

  const withoutTests = await runDoctor({ ...options, extensions: [] });
  expect(withoutTests.scope.files).toBe(1);
  expect(cacheStatus(root).files).toBe(1);
});
