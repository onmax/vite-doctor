import { expect, test } from "vite-plus/test";
import {
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

test("JSON and agent reports preserve diagnostic docs metadata", () => {
  const json = JSON.parse(createJsonReport(docsResult));
  const agent = JSON.parse(createAgentReport(docsResult));

  expect(json.diagnostics[0].docs).toBe("https://example.test/override");
  expect(json.diagnostics[1]).not.toHaveProperty("docs");
  expect(agent.diagnostics[0].docs).toBe("https://example.test/override");
  expect(agent.diagnostics[1]).not.toHaveProperty("docs");
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
