import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { returnNavigateToInMiddleware } from "../../../src/rule-packs/nuxt/rules/nuxt/return-navigate-to-in-middleware.ts";

test.each([
  `() => navigateTo("/login")`,
  `async () => await navigateTo("/login")`,
  `() => { return /* preserve redirect result */ navigateTo("/login") }`,
  `() => { return true ? navigateTo("/login") : undefined }`,
  `() => true ? navigateTo("/login") : undefined`,
  `() => navigateTo("/login") as Promise<void>`,
  `() => condition && navigateTo("/login")`,
  `() => condition || navigateTo("/login")`,
  `() => condition ?? navigateTo("/login")`,
  `() => { return condition && navigateTo("/login") }`,
  `async () => condition || await navigateTo("/login")`,
  `() => condition && (navigateTo("/login") as Promise<void>)`,
  `() => condition ? otherCondition && navigateTo("/login") : undefined`,
])("accepts a returned navigation result: %s", async (handler) => {
  const result = await runRuleFixture({
    framework: "nuxt",
    rule: returnNavigateToInMiddleware,
    files: { "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(${handler})` },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test.each([`() => { navigateTo("/login") }`, `async () => { await navigateTo("/login") }`])(
  "offers a return insertion for a standalone navigation statement: %s",
  async (handler) => {
    const source = `export default defineNuxtRouteMiddleware(${handler})`;
    const result = await runRuleFixture({
      framework: "nuxt",
      rule: returnNavigateToInMiddleware,
      files: { "app/middleware/auth.ts": source },
    });

    expect(result.diagnostics).toHaveLength(1);
    const edit = result.diagnostics[0]?.fix?.edits?.[0];
    expect(edit).toBeDefined();
    expect(source.slice(edit!.range.start)).toMatch(/^(?:await )?navigateTo/);
    expect(edit!.text).toBe("return ");
  },
);

test("does not insert a return inside a variable initializer", async () => {
  const result = await runRuleFixture({
    framework: "nuxt",
    rule: returnNavigateToInMiddleware,
    files: {
      "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => {
  const navigation = navigateTo("/login")
})`,
    },
  });

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.fix).toBeFalsy();
});

test.each([
  `() => { condition && navigateTo("/login") }`,
  `() => navigateTo("/login") && undefined`,
])("reports a navigation result that is not returned: %s", async (handler) => {
  const result = await runRuleFixture({
    framework: "nuxt",
    rule: returnNavigateToInMiddleware,
    files: { "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(${handler})` },
  });

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.fix).toBeFalsy();
});

test("does not insert a top-level return in a middleware module", async () => {
  const result = await runRuleFixture({
    framework: "nuxt",
    rule: returnNavigateToInMiddleware,
    files: { "app/middleware/auth.ts": `navigateTo("/login")` },
  });

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.fix).toBeFalsy();
});
