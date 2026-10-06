import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "pathe";
import { expect, test } from "vite-plus/test";
import { detectProject, runDoctor } from "../../src/core/index.ts";
import { createProjectFixture, runProjectFixture, runRuleFixture } from "../../src/testkit.ts";
import vitehubExtension, { noLegacyKvImport } from "../fixtures/extension-library/doctor.ts";

const legacy = 'import { kv } from "@vite-hub/kv/legacy";\nexport const store = kv;\n';

test("runRuleFixture reports a single Rule's Diagnostics", async () => {
  const result = await runRuleFixture({
    rule: noLegacyKvImport,
    framework: "vite",
    files: { "src/store.ts": legacy, "src/ok.ts": 'import { kv } from "@vite-hub/kv";\n' },
  });
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      code: "VHUB0001",
      ruleId: "vitehub/no-legacy-kv-import",
      severity: "warn",
      category: "correctness",
      range: expect.objectContaining({ line: 1, column: 1 }),
    }),
  ]);
  expect(result.diagnostics[0]!.file.endsWith("src/store.ts")).toBe(true);
});

test("runProjectFixture runs a published Doctor Extension", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    extensions: [vitehubExtension],
    files: { "src/store.ts": legacy },
  });
  expect(result.diagnostics.map((item) => item.docs)).toEqual([
    "https://vitehub.example/doctor/VHUB0001",
  ]);
});

test("createProjectFixture shares one fixture project and removes run files after each run", async () => {
  const project = createProjectFixture({ framework: "vite", files: { "src/shared.ts": legacy } });
  try {
    const first = await project.run({ rule: noLegacyKvImport, files: { "src/store.ts": legacy } });
    const second = await project.run({ rule: noLegacyKvImport });
    const files = (result: typeof first) =>
      result.diagnostics.map((item) => relative(result.root, item.file)).sort();
    expect(second.root).toBe(first.root);
    expect(files(first)).toEqual(["src/shared.ts", "src/store.ts"]);
    expect(files(second)).toEqual(["src/shared.ts"]);
    await expect(
      project.run({ rule: noLegacyKvImport, files: { "src/shared.ts": "" } }),
    ).rejects.toThrow("Run file src/shared.ts replaces a project fixture file.");
  } finally {
    await project.dispose();
  }
});

test("runDoctor reuses a precomputed Project Inventory without changing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "vite-doctor-project-"));
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { vite: "^8.0.0" } }),
    );
    const project = await detectProject(root, "vite");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/store.ts"), `${legacy}const broken = ;\n`);
    const extensions = [vitehubExtension];
    const result = await runDoctor({ project: { ...project, framework: "vue" }, extensions });
    expect(result.root).toBe(project.root);
    expect(result.framework).toBe("vue");
    expect(result.project.evidenceGaps).toEqual([
      expect.objectContaining({ source: "script-parser" }),
    ]);
    expect(project.evidenceGaps).toBeUndefined();
    expect((await runDoctor({ root, project, extensions })).diagnostics).toEqual(
      result.diagnostics,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
