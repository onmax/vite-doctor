import { expect, test } from "vite-plus/test";
import { createRule, defineDoctorDiagnostics, type ScriptAstNodeOf } from "../../src/extension.ts";
import { runRuleFixture } from "../../src/core/testkit.ts";

const acmeDiagnostics = defineDoctorDiagnostics(
  [
    { code: "ACME0001", ruleId: "acme/no-legacy-client" },
    { code: "ACME0002", ruleId: "acme/single-client" },
  ],
  { docsBase: "https://acme.dev/doctor" },
);

const noLegacyClient = createRule({
  meta: {
    id: "acme/no-legacy-client",
    title: "Use the current Acme client",
    category: "correctness",
    severity: "warn",
    prefilter: { imports: ["acme/legacy"] },
  },
  create(ctx) {
    return {
      ImportDeclaration(node) {
        if (node.source.value !== "acme/legacy") return;
        ctx.report(
          acmeDiagnostics.diagnostics.ACME0001({
            why: "`acme/legacy` is removed in Acme 3.",
            fix: "Import `createClient` from `acme` instead.",
          }),
          { range: ctx.range(node) },
        );
      },
    };
  },
});

const singleClient = createRule({
  meta: {
    id: "acme/single-client",
    title: "Create one Acme client per module",
    category: "correctness",
    severity: "warn",
    prefilter: { calls: ["createClient"] },
  },
  create(ctx) {
    const clients: ScriptAstNodeOf<"CallExpression">[] = [];
    return {
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "createClient") {
          clients.push(node);
        }
      },
      "Program:exit"() {
        for (const node of clients.slice(1)) {
          ctx.report(
            acmeDiagnostics.diagnostics.ACME0002({
              why: "Each client opens its own connection pool.",
              fix: "Reuse the first client in this module.",
            }),
            { range: ctx.range(node) },
          );
        }
      },
    };
  },
});

test("import visitors report the documented legacy import", async () => {
  const result = await runRuleFixture({
    rule: noLegacyClient,
    framework: "vite",
    files: {
      "src/client.ts": 'import { createClient } from "acme/legacy";\n',
      "src/current.ts": 'import { createClient } from "acme";\n',
    },
  });

  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["ACME0001"]);
});

test("exit visitors see every node collected during the walk", async () => {
  const result = await runRuleFixture({
    rule: singleClient,
    framework: "vite",
    files: {
      "src/a.ts":
        "const a = createClient();\nconst b = createClient();\nconst c = createClient();\n",
      "src/b.ts": "const a = createClient();\n",
    },
  });

  expect(
    result.diagnostics.map((diagnostic) => [
      diagnostic.file.split("/").at(-1),
      diagnostic.range?.line,
    ]),
  ).toEqual([
    ["a.ts", 2],
    ["a.ts", 3],
  ]);
});
