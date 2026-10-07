import { expect, test } from "vite-plus/test";
import type { ScriptAstNodeOf, SourceFileHandle } from "../../src/core/primitives.ts";
import { createHelpers } from "../../src/core/internal/doctor-helpers.ts";
import { parseScript } from "../../src/core/internal/script.ts";
import { runVisitor } from "../../src/core/internal/rule-runner.ts";

function sourceFile(source: string): SourceFileHandle {
  return {
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
}

test("client execution context stays stable across repeated helper calls", async () => {
  const source = "onMounted(() => window.alert('ready')); window.alert('setup');";
  const file = sourceFile(source);
  const calls: unknown[] = [];
  await runVisitor(
    {
      CallExpression(node) {
        calls.push(node);
      },
    },
    file,
  );

  const helpers = createHelpers();
  const results = calls.map((node) =>
    Array.from({ length: 8 }, () => helpers.isClientOnlyExecutionContext(node, source)),
  );

  expect(results).toEqual([
    [false, false, false, false, false, false, false, false],
    [true, true, true, true, true, true, true, true],
    [false, false, false, false, false, false, false, false],
  ]);
});

test("parent-chain memoization observes a changed direct parent", async () => {
  const source = "onMounted(() => window.alert('ready'));";
  const file = sourceFile(source);
  let target: ScriptAstNodeOf<"CallExpression"> | undefined;
  await runVisitor(
    {
      CallExpression(node) {
        if (String(node.callee.type).endsWith("MemberExpression")) target = node;
      },
    },
    file,
  );

  const helpers = createHelpers();
  if (!target) throw new Error("Expected the nested member call.");
  expect(helpers.isClientOnlyExecutionContext(target, source)).toBe(true);
  Object.defineProperty(target, "__doctorParent", {
    value: { type: "Program" },
    configurable: true,
  });
  expect(helpers.isClientOnlyExecutionContext(target, source)).toBe(false);
});
