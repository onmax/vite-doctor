import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { main } from "../../src/cli.ts";
import { allDiagnostics, createSarifReport, type ProjectInfo } from "../../src/core/index.ts";
import { createResult, normalizeDiagnostic } from "../../src/core/internal/diagnostics.ts";

const project: ProjectInfo = {
  root: "/project",
  framework: "vite",
  ssr: false,
  vueVersion: "3.5",
  isMonorepo: false,
};
const finding = normalizeDiagnostic({
  diagnostic: allDiagnostics.DOC9999({ why: "A real finding.", fix: "Repair the source." }),
  ruleId: "test/finding",
  severity: "error",
  category: "test",
  file: "/project/app.ts",
});
const gaps = [
  { source: "parser", message: "Repair the source syntax.", files: ["/project/broken.ts"] },
  { source: "manifest", message: "Regenerate the host manifest.", files: [] },
];

test.each([false, true])(
  "SARIF marks complete analysis successful with findings=%s",
  (hasFinding) => {
    const result = createResult(project, project.root, hasFinding ? [finding] : [], [], {});
    const run = JSON.parse(createSarifReport(result)).runs[0];

    expect(run.properties.status).toBe(hasFinding ? "findings" : "clean");
    expect(run.invocations).toEqual([{ executionSuccessful: true }]);
    expect(run.results).toHaveLength(hasFinding ? 1 : 0);
  },
);

test.each([false, true])("SARIF exposes evidence gaps without losing findings=%s", (hasFinding) => {
  const result = createResult(
    { ...project, evidenceGaps: gaps },
    project.root,
    hasFinding ? [finding] : [],
    [],
    {},
  );
  const run = JSON.parse(createSarifReport(result)).runs[0];

  expect(run.properties.status).toBe("incomplete");
  expect(run.invocations).toEqual([
    {
      executionSuccessful: false,
      toolExecutionNotifications: gaps.map((gap) => ({
        level: "error",
        message: { text: gap.message },
        properties: { source: gap.source, files: gap.files },
      })),
    },
  ]);
  expect(run.results).toHaveLength(hasFinding ? 1 : 0);
  if (hasFinding) expect(run.results[0].ruleId).toBe("test/finding:DOC9999");
  expect(run.tool.driver.rules).toHaveLength(hasFinding ? 1 : 0);
});

test.each([
  {
    framework: "vue" as const,
    runtimeGraph: {
      packages: {
        vue: {
          runtime: "vue" as const,
          state: "unknown" as const,
          requestedName: "vue",
          owner: "project" as const,
          provenance: "node-resolve" as const,
          reason: "Package is not installed.",
        },
      },
      edges: [],
    },
  },
  { nuxtCompatibility: { state: "unknown" as const, provenance: "config" as const } },
])("SARIF marks unresolved runtime evidence incomplete: %j", (unknownEvidence) => {
  const result = createResult({ ...project, ...unknownEvidence }, project.root, [], [], {});
  const run = JSON.parse(createSarifReport(result)).runs[0];

  expect(run.properties.status).toBe("incomplete");
  expect(run.invocations[0]).toMatchObject({
    executionSuccessful: false,
    toolExecutionNotifications: [{ level: "error", message: { text: expect.any(String) } }],
  });
  expect(run.invocations[0].toolExecutionNotifications[0].message.text).toContain(
    "Install project dependencies",
  );
  expect(run.results).toEqual([]);
});

test("CLI SARIF retains Extension evidence gaps across cached runs and clears them on repair", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-sarif-status-"));
  try {
    await writeFile(join(root, "package.json"), '{ "type": "module" }');
    await writeFile(join(root, "missing-evidence"), "missing");
    await writeFile(
      join(root, "doctor.config.mjs"),
      `import { existsSync } from "node:fs";
export default { extensions: [{ name: "fixture-evidence", setup(api) {
  api.registerProjectInventoryContributor({ name: "fixture-evidence", contribute(project) {
    if (existsSync(project.root + "/missing-evidence")) {
      project.evidenceGaps = [{ source: "fixture-evidence", message: "Regenerate the manifest.", files: ["manifest.json"] }];
    }
    return {};
  } });
} }] };`,
    );
    const runCli = async () => {
      const chunks: string[] = [];
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      try {
        const code = await main(
          [".", "--framework", "vite", "--config", "doctor.config.mjs", "--format", "sarif"],
          root,
        );
        return { code, run: JSON.parse(chunks.join("")).runs[0] };
      } finally {
        process.stdout.write = write;
      }
    };

    for (let runNumber = 0; runNumber < 2; runNumber++) {
      const { code, run } = await runCli();
      expect(code).toBe(3);
      expect(run.results).toEqual([]);
      expect(run.invocations[0]).toMatchObject({
        executionSuccessful: false,
        toolExecutionNotifications: [
          {
            level: "error",
            message: { text: "Regenerate the manifest." },
            properties: { source: "fixture-evidence", files: ["manifest.json"] },
          },
        ],
      });
    }
    await rm(join(root, "missing-evidence"));
    const repaired = await runCli();
    expect(repaired.code).toBe(0);
    expect(repaired.run.properties.status).toBe("clean");
    expect(repaired.run.invocations).toEqual([{ executionSuccessful: true }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
