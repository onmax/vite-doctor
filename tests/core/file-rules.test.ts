import { expect, test } from "vite-plus/test";
import { allDiagnostics } from "../../src/core/index.ts";
import { createRule } from "../../src/core/primitives.ts";
import { runProjectFixture } from "../../src/core/testkit.ts";

function reportingRule(id: string) {
  return createRule({
    meta: { id, title: id, category: "correctness", severity: "warn", requires: { script: true } },
    create(ctx) {
      return {
        ScriptNode(node: any) {
          if (node.type !== "VariableDeclarator") return;
          ctx.report(allDiagnostics.DOC9999({ why: "Fixture.", fix: "Fixture." }), {
            ruleId: id,
            severity: "warn",
            category: "correctness",
            range: ctx.range(node),
          });
        },
      };
    },
  });
}

const files = {
  "src/a.ts": "export const a = 1",
  "src/b.ts": "export const b = 2; export const c = 3",
};
const rules = [reportingRule("test/first"), reportingRule("test/second")];

test("file rule Diagnostics keep rule-major order across files", async () => {
  const result = await runProjectFixture({ files, framework: "vite", rules });

  expect(
    result.diagnostics.map(
      (diagnostic) => `${diagnostic.ruleId} ${diagnostic.file.split("/").at(-1)}`,
    ),
  ).toEqual([
    "test/first a.ts",
    "test/first b.ts",
    "test/first b.ts",
    "test/second a.ts",
    "test/second b.ts",
    "test/second b.ts",
  ]);
});

test("profiled runs count applicable files for each file rule", async () => {
  const result = await runProjectFixture({
    files,
    framework: "vite",
    rules,
    run: { profile: true },
  });

  expect(
    Object.fromEntries((result.ruleTimings ?? []).map((timing) => [timing.rule, timing.files])),
  ).toEqual({ "test/first": 2, "test/second": 2 });
});

test.each([false, true])(
  "file rules share state in file-first lifecycle order (profile: %s)",
  async (profile) => {
    const events: string[] = [];
    let state = "initial";
    const lifecycleRules = ["first", "second"].map((name) =>
      createRule({
        meta: {
          id: `test/${name}`,
          title: name,
          category: "correctness",
          severity: "warn",
          requires: { script: true },
        },
        async create(ctx) {
          await Promise.resolve();
          const file = ctx.file.relativePath;
          events.push(`${file}:${name}:create:${state}`);
          state = `${name}:created`;
          return {
            async SFC() {
              await Promise.resolve();
              events.push(`${file}:${name}:sfc:${state}`);
              state = `${name}:sfc`;
            },
            ScriptNode(node: any) {
              if (node.type !== "Program") return;
              events.push(`${file}:${name}:script:${state}`);
              state = `${name}:script`;
            },
            TemplateNode(node: any) {
              if (node !== ctx.file.templateAst) return;
              events.push(`${file}:${name}:template:${state}`);
              state = `${name}:template`;
            },
          };
        },
      }),
    );

    await runProjectFixture({
      files: {
        "src/a.vue": "<script setup>const a = 1</script><template><div /></template>",
        "src/b.vue": "<script setup>const b = 2</script><template><div /></template>",
      },
      framework: "vue",
      rules: lifecycleRules,
      run: { profile },
    });

    expect(events).toEqual(
      ["src/a.vue", "src/b.vue"].flatMap((file, index) => [
        `${file}:first:create:${index === 0 ? "initial" : "second:template"}`,
        `${file}:second:create:first:created`,
        `${file}:first:sfc:second:created`,
        `${file}:second:sfc:first:sfc`,
        `${file}:first:script:second:sfc`,
        `${file}:second:script:first:script`,
        `${file}:first:template:second:script`,
        `${file}:second:template:first:template`,
      ]),
    );
  },
);
