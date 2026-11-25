import { expect, test } from "vite-plus/test";
import {
  holdsRequestValue,
  type RequestValueSources,
} from "../../src/core/internal/request-values.ts";
import { runVisitor } from "../../src/core/internal/rule-runner.ts";
import { parseScript } from "../../src/core/internal/script.ts";
import { findStatementBinding } from "../../src/core/internal/script-index.ts";

async function traceRendered(source: string, sources: RequestValueSources) {
  const scriptAst = parseScript("fixture.ts", source);
  let traced: boolean | undefined;
  await runVisitor(
    {
      VariableDeclarator(node) {
        if (node.id?.type === "Identifier" && node.id.name === "rendered") {
          traced = holdsRequestValue(node.init, {
            programBinding: findStatementBinding,
            projectObjectMembers: true,
            ...sources,
          });
        }
      },
    },
    {
      path: "/fixture.ts",
      relativePath: "fixture.ts",
      sourceKind: "app",
      text: source,
      hash: "fixture",
      isVueSfc: false,
      scriptAst,
      project: { root: "/", framework: "nuxt", ssr: true, vueVersion: "3.5.0", isMonorepo: false },
      matches: () => true,
      inAppDir: () => true,
      isModuleSource: () => false,
    },
  );
  return traced;
}

test("traces a shared menu initializer once at the same depth", async () => {
  const lists = Array.from({ length: 5 }, (_, level) => {
    const groups = Array.from(
      { length: 8 },
      (_, group) => `{ title: 'Group ${group}', children: list${level} }`,
    );
    return `const list${level + 1} = [${groups.join(", ")}]`;
  });
  let leafVisits = 0;
  const traced = await traceRendered(
    [
      "const cookie = useCookie('theme')",
      "const list0 = [1]",
      ...lists,
      "const rendered = list5.length",
    ].join("\n"),
    {
      maxDepth: 8,
      isSource(node) {
        if (node.type === "Literal" && node.value === 1) leafVisits++;
        return node.type === "CallExpression" && node.callee.name === "useCookie";
      },
    },
  );
  expect(traced).toBe(false);
  expect(leafVisits).toBe(1);
});

test("revisits a shared initializer when a shallower reference can reach the source", async () => {
  const traced = await traceRendered(
    `const cookie = useCookie('theme')
const shared = cookie
const nested = shared
const rendered = [nested, shared]`,
    {
      maxDepth: 2,
      isSource: (node) => node.type === "CallExpression" && node.callee.name === "useCookie",
    },
  );
  expect(traced).toBe(true);
});
