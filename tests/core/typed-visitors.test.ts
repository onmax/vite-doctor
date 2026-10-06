import { expect, test } from "vite-plus/test";
import { createRule, defineDoctorDiagnostics, type ScriptAstNodeOf } from "../../src/extension.ts";
import { runRuleFixture } from "../../src/core/testkit.ts";

const acmeDiagnostics = defineDoctorDiagnostics(
  [
    { code: "ACME0001", ruleId: "acme/no-legacy-client" },
    { code: "ACME0002", ruleId: "acme/single-client" },
    { code: "ACME0003", ruleId: "acme/image" },
    { code: "ACME0004", ruleId: "acme/image" },
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

const acmeImage = createRule({
  meta: {
    id: "acme/image",
    title: "Use accessible, secure Acme images",
    category: "a11y",
    severity: "warn",
  },
  create(ctx) {
    return {
      template: {
        element(node) {
          if (node.tag !== "AcmeImage") return;
          if (
            ctx.helpers.hasVueAttribute(node, "alt") ||
            ctx.helpers.hasVueDirective(node, "bind", "alt")
          )
            return;
          ctx.report(
            acmeDiagnostics.diagnostics.ACME0003({
              why: "Screen readers announce an image without alt text by its file name.",
              fix: 'Add alt text, or alt="" for a decorative image.',
            }),
            { range: ctx.range(node) },
          );
        },
        directive(node, element) {
          if (element.tag !== "AcmeImage" || node.name !== "bind" || node.arg?.content !== "src")
            return;
          const expression = node.exp && ctx.helpers.parseTemplateExpression(node.exp);
          if (expression?.type !== "Literal" || !String(expression.value).startsWith("http:"))
            return;
          ctx.report(
            acmeDiagnostics.diagnostics.ACME0004({
              why: "An http: image on an https: page is mixed content that browsers upgrade or block.",
              fix: "Serve the image over https:.",
            }),
            { range: ctx.range(expression) },
          );
        },
      },
    };
  },
});

test("template visitors report the documented image problems", async () => {
  const source = `<template>
  <AcmeImage :src="'http://cdn.acme.dev/a.png'" alt="Logo" />
  <AcmeImage src="/b.png" />
  <AcmeImage :src="url" :alt="label" />
</template>
`;
  const result = await runRuleFixture({
    rule: acmeImage,
    framework: "vue",
    files: { "src/App.vue": source },
  });

  const literal = "'http://cdn.acme.dev/a.png'";
  expect(
    result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.range?.start]),
  ).toEqual([
    ["ACME0004", source.indexOf(literal)],
    ["ACME0003", source.indexOf('<AcmeImage src="/b.png" />')],
  ]);
  expect(result.diagnostics[0]!.range?.end).toBe(source.indexOf(literal) + literal.length);
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
