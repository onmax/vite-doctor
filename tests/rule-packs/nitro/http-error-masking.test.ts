import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { noHttpErrorMasking } from "../../../src/rule-packs/nitro/rules/no-http-error-masking.ts";

test("reports when a Nitro catch masks an intentional HTTP error", async () => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: {
      "server/api/account.ts": `export default defineEventHandler(async () => {
        try {
          throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
        } catch (error) {
          throw createError({ statusCode: 500, statusMessage: 'Internal error' })
        }
      })`,
    },
  });
  expect(result.diagnostics.map((item) => item.code)).toContain("NITRO0018");
});

test("keeps a catch that preserves intentional HTTP errors", async () => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: {
      "server/api/account.ts": `export default defineEventHandler(async () => {
        try {
          throw createError({ statusCode: 401 })
        } catch (error) {
          if (isError(error)) throw error
          throw createError({ statusCode: 500 })
        }
      })`,
    },
  });
  expect(result.diagnostics.some((item) => item.ruleId === noHttpErrorMasking.meta.id)).toBe(false);
});

test.each([
  [
    "optional catch binding",
    "throw createError({ statusCode: 401 })",
    "throw createError({ statusCode: 500 })",
    true,
  ],
  [
    "conditional rethrow",
    "throw createError({ statusCode: 401 })",
    "if (debug) throw error; throw createError({ statusCode: 500 })",
    true,
  ],
  [
    "nested callback rethrow",
    "throw createError({ statusCode: 401 })",
    "const callback = () => { throw error }; throw createError({ statusCode: 500 })",
    true,
  ],
  [
    "shadowed binding",
    "throw createError({ statusCode: 401 })",
    "{ const error = other; if (isError(error)) throw error }; throw createError({ statusCode: 500 })",
    true,
  ],
  [
    "uncalled helper",
    "const helper = () => { throw createError({ statusCode: 401 }) }; work()",
    "throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "internally handled error",
    "try { throw createError({ statusCode: 401 }) } catch {} work()",
    "throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "unconditional rethrow",
    "throw createError({ statusCode: 401 })",
    "throw error; throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "unreachable rethrow",
    "throw createError({ statusCode: 401 })",
    "throw createError({ statusCode: 500 }); throw error",
    true,
  ],
  [
    "nested callback conversion",
    "throw createError({ statusCode: 401 })",
    "const callback = () => { throw createError({ statusCode: 500 }) }; throw error",
    false,
  ],
  [
    "finally consumes error",
    "try { throw createError({ statusCode: 401 }) } finally { return }",
    "throw createError({ statusCode: 500 })",
    false,
  ],
])("handles %s", async (name, body, handler, expected) => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: {
      "server/api/account.ts": `export default defineEventHandler(() => {
        try { ${body} } catch ${name === "optional catch binding" ? "" : "(error)"} { ${handler} }
      })`,
    },
  });
  expect(result.diagnostics.some((item) => item.code === "NITRO0018")).toBe(expected);
});

test.each([
  "api/account.ts",
  "routes/account.ts",
  "server/api/account.ts",
  "app/server/api/account.ts",
])("analyzes Nitro handler %s", async (file) => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: {
      [file]: `export default defineEventHandler(() => {
      try { throw createError({ statusCode: 401 }) }
      catch { throw createError({ statusCode: 500 }) }
    })`,
    },
  });
  expect(result.diagnostics.map((item) => item.code)).toContain("NITRO0018");
});

test.each([
  [
    "nested rethrow",
    `try {
    try { throw createError({ statusCode: 401 }) }
    catch (error) { if (isError(error)) throw error }
  } catch { throw createError({ statusCode: 500 }) }`,
    true,
  ],
  [
    "finalizer returns",
    `try { throw createError({ statusCode: 401 }) }
    catch { throw createError({ statusCode: 500 }) } finally { return }`,
    false,
  ],
  [
    "finalizer throws",
    `try { throw createError({ statusCode: 401 }) }
    catch { throw createError({ statusCode: 500 }) } finally { throw new Error() }`,
    false,
  ],
  [
    "finalizer conditionally returns",
    `try { throw createError({ statusCode: 401 }) }
    catch { throw createError({ statusCode: 500 }) } finally { if (stop) return }`,
    true,
  ],
  [
    "correlated preservation",
    `try {
    if (missing) throw createError({ statusCode: 404 }); throw new Error()
  } catch (error) { if (missing) throw error; throw createError({ statusCode: 500 }) }`,
    false,
  ],
  [
    "correlated masking",
    `try {
    if (missing) throw createError({ statusCode: 404 }); throw new Error()
  } catch (error) { if (!missing) throw error; throw createError({ statusCode: 500 }) }`,
    true,
  ],
  [
    "reassigned condition",
    `try {
    if (missing) throw createError({ statusCode: 404 }); throw new Error()
  } catch (error) { missing = false; if (missing) throw error; throw createError({ statusCode: 500 }) }`,
    true,
  ],
  [
    "correlated finalizer",
    `try {
    if (missing) throw createError({ statusCode: 404 }); throw new Error()
  } catch { throw createError({ statusCode: 500 }) } finally { if (missing) return }`,
    false,
  ],
])("handles %s", async (_name, body, expected) => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: { "server/api/account.ts": `export default defineEventHandler(() => { ${body} })` },
  });
  expect(result.diagnostics.some((item) => item.code === "NITRO0018")).toBe(expected);
});
