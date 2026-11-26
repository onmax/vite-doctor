import { expect, test, vi } from "vite-plus/test";
import {
  type ProjectInfo,
  allDiagnostics,
  createAgentReport,
  createJsonReport,
  createReport,
  createSarifReport,
  defineDoctorDiagnostics,
} from "../../src/core/index.ts";
import { createResult, normalizeDiagnostic } from "../../src/core/internal/diagnostics.ts";

const root = "/project";

function makeDiagnostic(ruleId: string, diagnostic: any) {
  return {
    diagnostic,
    code: diagnostic.name,
    why: diagnostic.why,
    ruleId,
    severity: "warn",
    category: "test",
    message: diagnostic.why,
    file: `${root}/src/app.ts`,
    fingerprint: `${ruleId}:${diagnostic.name}`,
  };
}

function sarifFor(diagnostics: unknown[]) {
  return JSON.parse(
    createReport(
      {
        version: "0.0.0",
        root,
        project: { ...docsProject, root },
        diagnostics,
      } as any,
      "sarif",
    ),
  ).runs[0];
}

test("sarif diagnostic identities do not depend on finding count", () => {
  const ruleId = "test/stable-rule";
  const diagnostic = allDiagnostics.DOC9999({ why: "Finding", fix: "Fix finding" });
  const single = sarifFor([makeDiagnostic(ruleId, diagnostic)]);
  const duplicate = sarifFor([
    makeDiagnostic(ruleId, diagnostic),
    makeDiagnostic(ruleId, diagnostic),
  ]);

  expect(single.results[0].ruleId).toBe("test/stable-rule:DOC9999");
  expect(duplicate.results.map((result: { ruleId: string }) => result.ruleId)).toEqual([
    "test/stable-rule:DOC9999",
    "test/stable-rule:DOC9999",
  ]);
  expect(duplicate.tool.driver.rules.map((rule: { id: string }) => rule.id)).toEqual([
    "test/stable-rule:DOC9999",
  ]);
});

test("sarif diagnostic identities distinguish codes emitted by one rule", () => {
  const ruleId = "test/multi-code-rule";
  const first = allDiagnostics.DOC0001({ why: "First finding", fix: "Fix first finding" });
  const second = allDiagnostics.DOC0002({ why: "Second finding", fix: "Fix second finding" });
  const sarif = sarifFor([makeDiagnostic(ruleId, first), makeDiagnostic(ruleId, second)]);

  expect(sarif.results.map((result: { ruleId: string }) => result.ruleId)).toEqual([
    "test/multi-code-rule:DOC0001",
    "test/multi-code-rule:DOC0002",
  ]);
  expect(sarif.tool.driver.rules.map((rule: { id: string }) => rule.id)).toEqual([
    "test/multi-code-rule:DOC0001",
    "test/multi-code-rule:DOC0002",
  ]);
});

const docsRegistry = defineDoctorDiagnostics([
  {
    code: "TEST0001",
    ruleId: "test/docs-override",
    docs: "https://example.test/override",
  },
  { code: "TEST0002", ruleId: "test/docs-opt-out", docs: false },
]);

const docsProject = {
  root: "/tmp/vite-doctor-reports",
  framework: "vite" as const,
  ssr: false,
  vueVersion: ">=3.5",
  isMonorepo: false,
};

const docsDiagnostics = [
  normalizeDiagnostic({
    diagnostic: docsRegistry.diagnostics.TEST0001({
      why: "The override diagnostic.",
      fix: "Apply the override fix.",
    }),
    ruleId: "test/docs-override",
    severity: "warn",
    category: "test",
    file: `${docsProject.root}/override.ts`,
  }),
  normalizeDiagnostic({
    diagnostic: docsRegistry.diagnostics.TEST0002({
      why: "The opt-out diagnostic.",
      fix: "Apply the opt-out fix.",
    }),
    ruleId: "test/docs-opt-out",
    severity: "warn",
    category: "test",
    file: `${docsProject.root}/opt-out.ts`,
  }),
];

const docsResult = createResult(docsProject, docsProject.root, docsDiagnostics, [], {});

test.each(["text", "agent"] as const)(
  "%s includes all detail when the full rendering fits exactly",
  (format) => {
    const result = createResult(
      docsProject,
      docsProject.root,
      [...docsDiagnostics, { ...docsDiagnostics[0]!, data: { text: '🎉 "\n' } }],
      [],
      {},
    );
    const full = createReport(result, format, { runOptions: { maxChars: Infinity } });
    expect(createReport(result, format, { runOptions: { maxChars: full.length } })).toBe(full);
  },
);

test("budgeted agent reports never serialize oversized hidden detail as a report", () => {
  const result = createResult(
    docsProject,
    docsProject.root,
    Array.from({ length: 12 }, () => ({
      ...docsDiagnostics[0]!,
      data: { text: "d".repeat(2000) },
    })),
    [],
    {},
  );
  const stringify = JSON.stringify;
  const spy = vi.spyOn(JSON, "stringify").mockImplementation((value) => {
    const output = stringify(value);
    if (value?.schema === "vite-doctor.agent/v3" && output.length > 8000) {
      throw new RangeError("Invalid string length");
    }
    return output;
  });
  let output: string;
  try {
    output = createAgentReport(result);
  } finally {
    spy.mockRestore();
  }
  expect(output.length).toBeLessThanOrEqual(8000);
  const report = JSON.parse(output);
  expect(report.budget.hidden).toEqual({ groups: 0, rows: 0, detail: 12 });
  expect(report.groups[0].diagnostics).toHaveLength(12);
  expect(report.groups[0].diagnostics[0]).not.toHaveProperty("data");
  expect(report.commandArgs.full).toContain("--full");
});

test("agent group evidence does not conflate ranges or related IDs", () => {
  const original = docsDiagnostics[0]!;
  const shared = { kind: "ast" as const, file: original.file, summary: "Shared evidence" };
  const result = createResult(
    docsProject,
    docsProject.root,
    [1, 2, 3].map((line) => ({
      ...original,
      evidence: [
        shared,
        {
          ...shared,
          summary: "Registration",
          range: { start: line, end: line + 1, column: 1, line },
        },
        { ...shared, summary: "Tool", relatedId: `tool-${line}` },
      ],
    })),
    [],
    {},
  );
  const report = JSON.parse(createAgentReport(result, { runOptions: { maxChars: Infinity } }));
  expect(report.groups[0].evidence).toEqual([
    { kind: "ast", path: "override.ts", summary: "Shared evidence" },
  ]);
  expect(report.groups[0].diagnostics[1].evidence).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        summary: "Registration",
        range: expect.objectContaining({ line: 2 }),
      }),
      expect.objectContaining({ summary: "Tool", relatedId: "tool-2" }),
    ]),
  );
});

test("JSON and agent reports preserve diagnostic docs metadata", () => {
  const json = JSON.parse(createJsonReport(docsResult));
  const agent = JSON.parse(createAgentReport(docsResult));

  expect(json.diagnostics[0].docs).toBe("https://example.test/override");
  expect(json.diagnostics[1]).not.toHaveProperty("docs");
  expect(agent.groups[0].docs).toBe("https://example.test/override");
  expect(agent.groups[1]).not.toHaveProperty("docs");
});

test("SARIF reports preserve diagnostic docs metadata", () => {
  const sarif = JSON.parse(createSarifReport(docsResult));
  const rules = sarif.runs[0].tool.driver.rules;
  const results = sarif.runs[0].results;

  expect(rules[0].helpUri).toBe("https://example.test/override");
  expect(rules[1]).not.toHaveProperty("helpUri");
  expect(results[0].properties.docs).toBe("https://example.test/override");
  expect(results[1].properties).not.toHaveProperty("docs");
});

test("every report format renders a Diagnostic without confidence or evidence as having none", () => {
  const text = createReport(docsResult, "text");
  const json = JSON.parse(createJsonReport(docsResult)).diagnostics[0];
  const agent = JSON.parse(createAgentReport(docsResult)).groups[0];
  const sarif = JSON.parse(createSarifReport(docsResult)).runs[0];

  expect(text).not.toContain("confidence:");
  expect(text).toContain("Confidence mix: 0 proven, 0 probable, 0 source-only, 2 undeclared");
  for (const diagnostic of [json, agent, agent.diagnostics[0]]) {
    expect(diagnostic).not.toHaveProperty("confidence");
    expect(diagnostic).not.toHaveProperty("evidence");
  }
  expect(sarif.results[0].properties).not.toHaveProperty("confidence");
  expect(sarif.results[0].properties).not.toHaveProperty("evidenceKinds");
  expect(sarif.tool.driver.rules[0].properties).not.toHaveProperty("confidence");
});

test("every report format keeps the confidence and evidence a Rule gave", () => {
  const [first] = docsDiagnostics;
  const result = createResult(
    docsProject,
    docsProject.root,
    [
      {
        ...first!,
        confidence: "manifest-backed",
        evidence: [{ kind: "manifest", summary: "package.json lists nuxt 4.1.0" }],
      },
    ],
    [],
    {},
  );
  const text = createReport(result, "text");
  const json = JSON.parse(createJsonReport(result)).diagnostics[0];
  const agent = JSON.parse(createAgentReport(result)).groups[0];
  const sarif = JSON.parse(createSarifReport(result)).runs[0].results[0];

  expect(text).toContain("confidence: manifest-backed");
  expect(text).toContain("evidence: manifest: package.json lists nuxt 4.1.0");
  for (const diagnostic of [json, agent]) {
    expect(diagnostic.confidence).toBe("manifest-backed");
    expect(diagnostic.evidence).toEqual([
      { kind: "manifest", summary: "package.json lists nuxt 4.1.0" },
    ]);
  }
  expect(agent.diagnostics[0].evidence).toEqual(agent.evidence);
  expect(sarif.properties).toMatchObject({
    confidence: "manifest-backed",
    evidenceKinds: ["manifest"],
  });
});

test("workspace root heading omits the nested Nuxt owner's runtime versions", () => {
  const project: ProjectInfo = {
    ...docsProject,
    framework: "nuxt" as const,
    vueVersion: "3.5.13",
    nuxtVersion: "4.0.0",
    workspacePackages: [
      { root: ".", framework: "vue" as const, packages: { vue: "3.4.21" } },
      {
        root: "packages/site",
        framework: "nuxt" as const,
        packages: { vue: "3.5.13", nuxt: "4.0.0" },
      },
    ],
  };
  const result = createResult(project, project.root, [], [], {});
  result.framework = "vue";
  result.workspacePackages = [
    { root: ".", framework: "vue", rulePacks: [] },
    {
      root: "packages/site",
      framework: "nuxt",
      rulePacks: [],
    },
  ];
  const text = createReport(result, "text");
  expect(text).toContain("Vue at the root");
  expect(text).not.toContain("Vue 3.5.13 at the root");
});
