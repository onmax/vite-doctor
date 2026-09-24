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
    "trailing protected status spread",
    "throw createError({ statusCode: 404, ...options })",
    "throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "trailing catch status spread",
    "throw createError({ statusCode: 404 })",
    "throw createError({ statusCode: 500, ...options })",
    false,
  ],
  [
    "leading status spread",
    "throw createError({ ...options, statusCode: 404 })",
    "throw createError({ statusCode: 500 })",
    true,
  ],
  [
    "duplicate status override",
    "throw createError({ statusCode: 404, statusCode: 500 })",
    "throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "unknown status override",
    "throw createError({ statusCode: 404, statusCode: status })",
    "throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "computed status override",
    "throw createError({ statusCode: 404, [key]: 500 })",
    "throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "statusCode precedence",
    "throw createError({ status: 404, statusCode: 500 })",
    "throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "shadow before outer guard",
    "throw createError({ statusCode: 404 })",
    "{ const error = other }; if (isError(error)) throw error; throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "shadow assignment before outer guard",
    "throw createError({ statusCode: 404 })",
    "{ let error = other; error = changed }; if (isError(error)) throw error; throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "outer catch assignment",
    "throw createError({ statusCode: 404 })",
    "{ error = other }; if (isError(error)) throw error; throw createError({ statusCode: 500 })",
    true,
  ],
  [
    "shadow guard does not preserve",
    "throw createError({ statusCode: 404 })",
    "{ const error = other; if (isError(error)) throw error }; throw createError({ statusCode: 500 })",
    true,
  ],
  [
    "boolean true initializer",
    "throw createError({ statusCode: 404 })",
    "const preserve = true; if (preserve) throw error; throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "boolean false initializer",
    "throw createError({ statusCode: 404 })",
    "let preserve = false; if (!preserve) throw error; throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "boolean initializer reassigned",
    "throw createError({ statusCode: 404 })",
    "let preserve = true; preserve = false; if (preserve) throw error; throw createError({ statusCode: 500 })",
    true,
  ],
  [
    "boolean initializer block lifetime",
    "throw createError({ statusCode: 404 })",
    "{ const preserve = true; if (!preserve) throw error }; if (preserve) throw error; throw createError({ statusCode: 500 })",
    true,
  ],
  [
    "duplicate switch case",
    'switch (kind) { case "missing": break; case "missing": throw createError({ statusCode: 404 }) }',
    "throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "duplicate catch switch case",
    "throw createError({ statusCode: 404 })",
    'switch (kind) { case "missing": break; case "missing": throw createError({ statusCode: 500 }) }',
    false,
  ],
  [
    "duplicate switch fallthrough",
    'switch (kind) { case "missing": log(); case "missing": throw createError({ statusCode: 404 }) }',
    "throw createError({ statusCode: 500 })",
    true,
  ],

  [
    "switch client error",
    'switch (kind) { case "missing": throw createError({ statusCode: 404 }) }',
    "throw createError({ statusCode: 500 })",
    true,
  ],
  [
    "switch catch masking",
    "throw createError({ statusCode: 404 })",
    'switch (kind) { case "missing": throw createError({ statusCode: 500 }) }',
    true,
  ],
  [
    "switch fallthrough",
    'switch ("missing") { case "missing": log(); default: throw createError({ statusCode: 404 }) }',
    "throw createError({ statusCode: 500 })",
    true,
  ],
  [
    "switch break",
    'switch ("ok") { case "ok": break; default: throw createError({ statusCode: 404 }) }',
    "throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "switch default before matching case",
    'switch ("ok") { default: throw createError({ statusCode: 404 }); case "ok": break }',
    "throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "switch no matching case",
    'switch ("ok") { case "missing": throw createError({ statusCode: 404 }) }',
    "throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "switch break followed by error",
    'switch (kind) { case "ok": break } throw createError({ statusCode: 404 })',
    "throw createError({ statusCode: 500 })",
    true,
  ],
  [
    "labeled loop throw",
    "outer: for (;;) { throw createError({ statusCode: 400 }) }",
    "throw createError({ statusCode: 500 })",
    true,
  ],
  [
    "nested labeled break",
    "outer: for (;;) { for (;;) { break outer } throw createError({ statusCode: 400 }) }",
    "throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "labeled break reaches following throw",
    "outer: for (;;) { for (;;) { break outer } } throw createError({ statusCode: 400 })",
    "throw createError({ statusCode: 500 })",
    true,
  ],
  [
    "nested labeled continue",
    "outer: for (;;) { for (;;) { continue outer } throw createError({ statusCode: 400 }) }",
    "throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "labeled continue reaches later iteration",
    "outer: while (active) { if (missing) throw createError({ statusCode: 400 }); for (;;) { missing = true; continue outer } }",
    "throw createError({ statusCode: 500 })",
    true,
  ],
  [
    "multiple loop labels",
    "outer: inner: for (;;) { for (;;) { break outer } } throw createError({ statusCode: 400 })",
    "throw createError({ statusCode: 500 })",
    true,
  ],
  [
    "labeled block break",
    "outer: { break outer; throw createError({ statusCode: 400 }) }",
    "throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "finalizer preserves labeled break",
    "outer: for (;;) { for (;;) { try { break outer } finally { log() } } throw createError({ statusCode: 400 }) }",
    "throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "uninvoked callback catch assignment",
    "throw createError({ statusCode: 400 })",
    "const mutate = () => { error = other }; if (isError(error)) throw error; throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "uninvoked function catch assignment",
    "throw createError({ statusCode: 400 })",
    "function mutate() { error = other }; if (isError(error)) throw error; throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "negated H3 guard",
    "throw createError({ statusCode: 401 })",
    "if (!isError(error)) throw createError({ statusCode: 500 }); throw error",
    false,
  ],
  [
    "negated H3 guard alternate",
    "throw createError({ statusCode: 401 })",
    "if (!isError(error)) throw error; else throw createError({ statusCode: 500 })",
    true,
  ],
  [
    "literal assignment preserves",
    "if (missing) throw createError({ statusCode: 404 })",
    "missing = true; if (missing) throw error; throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "literal false assignment preserves",
    "throw createError({ statusCode: 404 })",
    "missing = false; if (!missing) throw error; throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "do while throw",
    "do { throw createError({ statusCode: 400 }) } while (false)",
    "throw createError({ statusCode: 500 })",
    true,
  ],
  [
    "while throw",
    "while (ready) { throw createError({ statusCode: 400 }) }",
    "throw createError({ statusCode: 500 })",
    true,
  ],
  [
    "unreachable while",
    "while (false) { throw createError({ statusCode: 400 }) }",
    "throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "for throw",
    "for (;;) { throw createError({ statusCode: 400 }) }",
    "throw createError({ statusCode: 500 })",
    true,
  ],
  [
    "for of throw",
    "for (const item of items) { throw createError({ statusCode: 400 }) }",
    "throw createError({ statusCode: 500 })",
    true,
  ],
  [
    "for in throw",
    "for (const key in items) { throw createError({ statusCode: 400 }) }",
    "throw createError({ statusCode: 500 })",
    true,
  ],
  [
    "loop break",
    "do { break; throw createError({ statusCode: 400 }) } while (false)",
    "throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "loop continue",
    "do { continue; throw createError({ statusCode: 400 }) } while (false)",
    "throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "later loop iteration",
    "ready = false; for (;;) { if (ready) throw createError({ statusCode: 400 }); ready = true }",
    "throw createError({ statusCode: 500 })",
    true,
  ],
  [
    "catch loop conversion",
    "throw createError({ statusCode: 400 })",
    "do { throw createError({ statusCode: 500 }) } while (false)",
    true,
  ],
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
