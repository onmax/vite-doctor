import { expect, test } from "vite-plus/test";
import { allDiagnostics, createReport } from "../../src/core/index.ts";

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
