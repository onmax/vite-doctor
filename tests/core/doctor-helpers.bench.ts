import { beforeAll, bench } from "vite-plus/test";
import type { SourceFileHandle } from "../../src/core/primitives.ts";
import { createHelpers } from "../../src/core/internal/doctor-helpers.ts";
import { parseScript } from "../../src/core/internal/script.ts";
import { runVisitor } from "../../src/core/internal/rule-runner.ts";

let file: SourceFileHandle;
let calls: unknown[];

beforeAll(async () => {
  let source = "leaf();";
  for (let index = 0; index < 100; index++) source = `function f${index}(){${source}} f${index}();`;
  file = {
    path: "/fixture.ts",
    relativePath: "fixture.ts",
    sourceKind: "app",
    text: source,
    hash: "fixture",
    isVueSfc: false,
    scriptAst: parseScript("fixture.ts", source),
    templateAst: null,
    project: {
      root: "/",
      framework: "vite",
      ssr: false,
      vueVersion: "3.5.0",
      isMonorepo: false,
    },
    matches: () => true,
    inAppDir: () => false,
    isModuleSource: () => false,
  };
  calls = [];
  await runVisitor({ CallExpression: (node) => calls.push(node) }, file);
});

bench("repeated client-context checks over nested calls", () => {
  const helpers = createHelpers();
  for (let repeat = 0; repeat < 20; repeat++)
    for (const node of calls) helpers.isClientOnlyExecutionContext(node, file.text);
});
