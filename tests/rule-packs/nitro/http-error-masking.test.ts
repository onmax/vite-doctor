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
    "404 as const",
    "throw createError({ statusCode: 404 as const })",
    "throw createError({ statusCode: 500 as const })",
    true,
  ],
  [
    "<number>404",
    "throw createError({ statusCode: <number>404 })",
    "throw createError({ statusCode: 500 as const })",
    true,
  ],
  [
    "404 satisfies number",
    "throw createError({ statusCode: 404 satisfies number })",
    "throw createError({ statusCode: 500 as const })",
    true,
  ],
  [
    "[missing()]",
    "function missing() { throw createError({ statusCode: 404 }) }; const value = [missing()]",
    "throw new Error()",
    true,
  ],
  [
    "[...missing()]",
    "function missing() { throw createError({ statusCode: 404 }) }; const value = [...missing()]",
    "throw new Error()",
    true,
  ],
  [
    "({ value: missing() })",
    "function missing() { throw createError({ statusCode: 404 }) }; const value = ({ value: missing() })",
    "throw new Error()",
    true,
  ],
  [
    "({ [missing()]: 1 })",
    "function missing() { throw createError({ statusCode: 404 }) }; const value = ({ [missing()]: 1 })",
    "throw new Error()",
    true,
  ],
  [
    "({ ...missing() })",
    "function missing() { throw createError({ statusCode: 404 }) }; const value = ({ ...missing() })",
    "throw new Error()",
    true,
  ],
  [
    "1 + missing()",
    "function missing() { throw createError({ statusCode: 404 }) }; const value = 1 + missing()",
    "throw new Error()",
    true,
  ],
  [
    "!missing()",
    "function missing() { throw createError({ statusCode: 404 }) }; const value = !missing()",
    "throw new Error()",
    true,
  ],
  [
    "`value: ${missing()}`",
    "function missing() { throw createError({ statusCode: 404 }) }; const value = `value: ${missing()}`",
    "throw new Error()",
    true,
  ],
  [
    "switch (missing()) {}",
    "function missing() { throw createError({ statusCode: 404 }) }; switch (missing()) {}",
    "throw new Error()",
    true,
  ],
  [
    "for (const item of missing()) {}",
    "function missing() { throw createError({ statusCode: 404 }) }; for (const item of missing()) {}",
    "throw new Error()",
    true,
  ],
  [
    "for (const item in missing()) {}",
    "function missing() { throw createError({ statusCode: 404 }) }; for (const item in missing()) {}",
    "throw new Error()",
    true,
  ],
  [
    "[fail(), missing()]",
    "function fail() { throw new Error() }; function missing() { throw createError({ statusCode: 404 }) }; const value = [fail(), missing()]",
    "throw new Error()",
    false,
  ],
  [
    "({ first: fail(), second: missing() })",
    "function fail() { throw new Error() }; function missing() { throw createError({ statusCode: 404 }) }; const value = ({ first: fail(), second: missing() })",
    "throw new Error()",
    false,
  ],
  [
    "({ [fail()]: missing() })",
    "function fail() { throw new Error() }; function missing() { throw createError({ statusCode: 404 }) }; const value = ({ [fail()]: missing() })",
    "throw new Error()",
    false,
  ],
  [
    "flag || !flag",
    "throw createError({ statusCode: 404 })",
    "if (flag || !flag) throw error; throw new Error()",
    false,
  ],
  [
    "!flag || flag",
    "throw createError({ statusCode: 404 })",
    "if (!flag || flag) throw error; throw new Error()",
    false,
  ],
  [
    "contradiction",
    "throw createError({ statusCode: 404 })",
    "if (flag && !flag) throw new Error(); throw error",
    false,
  ],

  [
    "compound preservation",
    "throw createError({ statusCode: 404 })",
    "if (error && isError(error)) throw error; throw new Error()",
    false,
  ],
  [
    "compound alternative",
    "throw createError({ statusCode: 404 })",
    "if (!error || !isError(error)) throw new Error(); throw error",
    false,
  ],
  [
    "throwing condition",
    "function missing() { throw createError({ statusCode: 404 }) }; if (missing()) {}",
    "throw new Error()",
    true,
  ],
  [
    "short circuit condition",
    "function missing() { throw createError({ statusCode: 404 }) }; if (false && missing()) {}",
    "throw new Error()",
    false,
  ],
  [
    "callee throws first",
    "function fail() { throw new Error() }; function missing() { throw createError({ statusCode: 404 }) }; fail()(missing())",
    "throw new Error()",
    false,
  ],
  [
    "member callee throws first",
    "function fail() { throw new Error() }; function missing() { throw createError({ statusCode: 404 }) }; fail().consume(missing())",
    "throw new Error()",
    false,
  ],
  [
    "TypeError replacement",
    "throw createError({ statusCode: 404 })",
    "throw new TypeError()",
    true,
  ],
  [
    "RangeError replacement",
    "throw createError({ statusCode: 404 })",
    "throw new RangeError()",
    true,
  ],
  [
    "ReferenceError replacement",
    "throw createError({ statusCode: 404 })",
    "throw new ReferenceError()",
    true,
  ],
  [
    "SyntaxError replacement",
    "throw createError({ statusCode: 404 })",
    "throw new SyntaxError()",
    true,
  ],
  ["URIError replacement", "throw createError({ statusCode: 404 })", "throw new URIError()", true],
  [
    "EvalError replacement",
    "throw createError({ statusCode: 404 })",
    "throw new EvalError()",
    true,
  ],
  [
    "AggregateError replacement",
    "throw createError({ statusCode: 404 })",
    "throw new AggregateError()",
    true,
  ],
  [
    "shadowed subclass",
    "throw createError({ statusCode: 404 })",
    "class TypeError {}; throw new TypeError()",
    false,
  ],
  [
    "throw argument",
    "function missing() { throw createError({ statusCode: 404 }) }; throw missing()",
    "throw new Error()",
    true,
  ],
  [
    "nested argument",
    "function missing() { throw createError({ statusCode: 404 }) }; consume(missing())",
    "throw new Error()",
    true,
  ],
  [
    "deep argument",
    "function missing() { throw createError({ statusCode: 404 }) }; consume(wrap(missing()))",
    "throw new Error()",
    true,
  ],
  [
    "constructor argument",
    "function missing() { throw createError({ statusCode: 404 }) }; new Response(missing())",
    "throw new Error()",
    true,
  ],
  [
    "awaited throw argument",
    "function missing() { throw createError({ statusCode: 404 }) }; throw await missing()",
    "throw new Error()",
    true,
  ],
  [
    "first argument throws before later masking helper",
    "function missing() { throw createError({ statusCode: 404 }) }; function fail() { throw new Error() }; consume(missing(), fail())",
    "throw new Error()",
    true,
  ],
  [
    "finite recursive masking",
    "throw createError({ statusCode: 404 })",
    "function replace(again) { if (again) return replace(false); throw new Error() }; replace(true)",
    true,
  ],
  [
    "local false boolean argument",
    "if (!missing) throw createError({ statusCode: 404 })",
    "function preserve(flag, value) { if (!flag) throw value }; preserve(missing, error); throw new Error()",
    false,
  ],
  [
    "earlier parameter default",
    "throw createError({ statusCode: 404 })",
    "function preserve(first, value = first) { if (isError(value)) throw value }; preserve(error); throw new Error()",
    false,
  ],
  [
    "returned awaited local throw",
    "async function missing() { throw createError({ statusCode: 404 }) }; return await missing()",
    "throw new Error()",
    true,
  ],
  [
    "returned synchronous local throw",
    "function missing() { throw createError({ statusCode: 404 }) }; return missing()",
    "throw new Error()",
    true,
  ],
  [
    "local boolean argument",
    "if (missing) throw createError({ statusCode: 404 })",
    "function preserve(flag, value) { if (flag) throw value }; preserve(missing, error); throw new Error()",
    false,
  ],
  [
    "default caught argument",
    "throw createError({ statusCode: 404 })",
    "function preserve(value = error) { if (isError(value)) throw value }; preserve(); throw new Error()",
    false,
  ],
  [
    "explicit undefined default",
    "throw createError({ statusCode: 404 })",
    "function preserve(value = error) { if (isError(value)) throw value }; preserve(undefined); throw new Error()",
    false,
  ],
  [
    "void literal default",
    "throw createError({ statusCode: 404 })",
    "function preserve(value = error) { if (isError(value)) throw value }; preserve(void 0); throw new Error()",
    false,
  ],
  [
    "shadowed undefined argument",
    "throw createError({ statusCode: 404 })",
    "const undefined = unknown; function preserve(value = error) { if (isError(value)) throw value }; preserve(undefined); throw new Error()",
    true,
  ],
  [
    "parameter shadowed undefined argument",
    "throw createError({ statusCode: 404 })",
    "function outer(undefined) { function preserve(value = error) { if (isError(value)) throw value }; preserve(undefined); throw new Error() }; outer(unknown)",
    true,
  ],
  [
    "undefined boolean default",
    "throw createError({ statusCode: 404 })",
    "function preserve(flag = true) { if (flag) throw error }; preserve(undefined); throw new Error()",
    false,
  ],
  [
    "undefined earlier parameter default",
    "throw createError({ statusCode: 404 })",
    "function preserve(first, value = first) { if (isError(value)) throw value }; preserve(error, undefined); throw new Error()",
    false,
  ],
  [
    "awaited initializer throw",
    "async function missing() { throw createError({ statusCode: 404 }) }; const account = await missing()",
    "throw new Error()",
    true,
  ],
  [
    "synchronous initializer throw",
    "function missing() { throw createError({ statusCode: 404 }) }; const account = missing()",
    "throw new Error()",
    true,
  ],
  [
    "destructured initializer throw",
    "function missing() { throw createError({ statusCode: 404 }) }; const { account } = missing()",
    "throw new Error()",
    true,
  ],
  [
    "initializer rethrow",
    "throw createError({ statusCode: 404 })",
    "function preserve() { throw error }; const account = preserve(); throw new Error()",
    false,
  ],
  [
    "statusCode replacement",
    "throw createError({ statusCode: 404 })",
    "error.statusCode = 500; throw error",
    true,
  ],
  [
    "status replacement",
    "throw createError({ statusCode: 404 })",
    "error.status = 500; throw error",
    true,
  ],
  [
    "computed status replacement",
    "throw createError({ statusCode: 404 })",
    'error["statusCode"] = 500; throw error',
    true,
  ],
  [
    "unrelated property write",
    "throw createError({ statusCode: 404 })",
    'error.message = "missing"; throw error',
    false,
  ],
  [
    "client status replacement",
    "throw createError({ statusCode: 404 })",
    "error.statusCode = 403; throw error",
    false,
  ],
  [
    "explicit argument overrides default",
    "throw createError({ statusCode: 404 })",
    "function preserve(value = error) { if (isError(value)) throw value }; preserve(unknown); throw new Error()",
    true,
  ],
  [
    "finite preserving recursion",
    "throw createError({ statusCode: 404 })",
    "function preserve(value, again) { if (again) return preserve(value, false); if (isError(value)) throw value }; preserve(error, true); throw new Error()",
    false,
  ],
  [
    "recursive bound does not return",
    "throw createError({ statusCode: 404 })",
    "function recur() { recur() }; recur(); throw new Error()",
    false,
  ],
  [
    "awaited local throw",
    "async function missing() { throw createError({ statusCode: 404 }) }; await missing()",
    "throw new Error()",
    true,
  ],
  [
    "unawaited local rejection",
    "async function missing() { throw createError({ statusCode: 404 }) }; missing()",
    "throw new Error()",
    false,
  ],
  [
    "local caught argument",
    "throw createError({ statusCode: 404 })",
    "function preserve(value) { if (isError(value)) throw value }; preserve(error); throw new Error()",
    false,
  ],
  [
    "IIFE argument shadows outer error",
    "throw createError({ statusCode: 404 })",
    "((error) => { if (isError(error)) throw error })(unknown); throw new Error()",
    true,
  ],
  [
    "shadowed function declaration",
    "if (missing) throw createError({ statusCode: 404 })",
    "function mutate() { missing = false }; { function mutate() {}; mutate() }; if (missing) throw error; throw new Error()",
    false,
  ],

  ["callable Error", "throw createError({ statusCode: 404 })", "throw Error('failed')", true],
  [
    "invoked local throw",
    "function missing() { throw createError({ statusCode: 404 }) }; missing()",
    "throw new Error()",
    true,
  ],
  [
    "uncalled local throw",
    "function missing() { throw createError({ statusCode: 404 }) }",
    "throw new Error()",
    false,
  ],
  ["recursive local call", "function recur() { recur() }; recur()", "throw new Error()", false],
  [
    "IIFE caught argument",
    "throw createError({ statusCode: 404 })",
    "((value) => { if (isError(value)) throw value })(error); throw new Error()",
    false,
  ],
  [
    "shadowed no-op callback",
    "if (missing) throw createError({ statusCode: 404 })",
    "const mutate = () => { missing = false }; { const mutate = () => {}; mutate() }; if (missing) throw error; throw new Error()",
    false,
  ],
  [
    "shadowed passed callback",
    "if (missing) throw createError({ statusCode: 404 })",
    "const mutate = () => { missing = false }; { const mutate = () => {}; consume(mutate) }; if (missing) throw error; throw new Error()",
    false,
  ],
  [
    "inspected condition callback",
    "if (missing) throw createError({ statusCode: 404 })",
    "const mutate = () => { missing = false }; void mutate; if (missing) throw error; throw new Error()",
    false,
  ],
  [
    "conditional function replacement",
    "let local = createError({ statusCode: 404 }); let mutate = () => {}; if (change) mutate = () => { local = new Error() }; else mutate = () => {}; mutate(); throw local",
    "throw new Error()",
    true,
  ],
  [
    "awaited async IIFE throw",
    "await (async () => { throw createError({ statusCode: 404 }) })()",
    "throw new Error()",
    true,
  ],
  [
    "awaited synchronous IIFE throw",
    "await (() => { throw createError({ statusCode: 404 }) })()",
    "throw new Error()",
    true,
  ],
  [
    "unawaited async IIFE rejection",
    "(async () => { throw createError({ statusCode: 404 }) })()",
    "throw new Error()",
    false,
  ],
  [
    "for-of catch target",
    "throw createError({ statusCode: 404 })",
    "for (error of [new Error()]) {}; if (isError(error)) throw error; throw new Error()",
    true,
  ],
  [
    "for-in catch target",
    "throw createError({ statusCode: 404 })",
    "for (error in object) {}; if (isError(error)) throw error; throw new Error()",
    true,
  ],
  [
    "for-of destructured catch target",
    "throw createError({ statusCode: 404 })",
    "for ({ value: error } of items) {}; if (isError(error)) throw error; throw new Error()",
    true,
  ],
  [
    "for-of shadowed catch target",
    "throw createError({ statusCode: 404 })",
    "for (const error of items) {}; if (isError(error)) throw error; throw new Error()",
    false,
  ],
  [
    "inspected callback binding",
    "throw createError({ statusCode: 404 })",
    "const mutate = () => { error = new Error() }; void mutate; if (isError(error)) throw error; throw new Error()",
    false,
  ],
  [
    "callback passed to a function",
    "throw createError({ statusCode: 404 })",
    "const mutate = () => { error = new Error() }; invoke(mutate); if (isError(error)) throw error; throw new Error()",
    true,
  ],
  [
    "nonboolean condition shadow",
    "if (missing) throw createError({ statusCode: 404 })",
    "{ const missing = readFlag() }; if (missing) throw error; throw new Error()",
    false,
  ],
  [
    "function reference before initialization",
    "throw createError({ statusCode: 404 })",
    "mutate(); const mutate = () => { error = new Error() }; if (isError(error)) throw error; throw new Error()",
    false,
  ],
  [
    "function replaced with no-op",
    "let local = createError({ statusCode: 404 }); let mutate = () => { local = new Error() }; mutate = () => {}; mutate(); throw local",
    "throw new Error()",
    true,
  ],
  [
    "no-op replaced with mutation",
    "let local = createError({ statusCode: 404 }); let mutate = () => {}; mutate = () => { local = new Error() }; mutate(); throw local",
    "throw new Error()",
    false,
  ],
  [
    "function replaced inside block",
    "let local = createError({ statusCode: 404 }); let mutate = () => { local = new Error() }; { mutate = () => {} }; mutate(); throw local",
    "throw new Error()",
    true,
  ],
  [
    "hoisted function declaration",
    "let local = createError({ statusCode: 404 }); mutate(); throw local; function mutate() { local = new Error() }",
    "throw new Error()",
    false,
  ],
  [
    "IIFE parameter shadow",
    "throw createError({ statusCode: 404 })",
    "((error) => { error = new Error() })(other); if (isError(error)) throw error; throw new Error()",
    false,
  ],
  [
    "IIFE var shadow",
    "throw createError({ statusCode: 404 })",
    "(() => { var error = new Error() })(); if (isError(error)) throw error; throw new Error()",
    false,
  ],
  [
    "generic Error replacement",
    "throw createError({ statusCode: 404 })",
    'throw new Error("failed")',
    true,
  ],
  [
    "default H3 replacement",
    "throw createError({ statusCode: 404 })",
    'throw createError({ message: "failed" })',
    true,
  ],
  [
    "string H3 replacement",
    "throw createError({ statusCode: 404 })",
    'throw createError("failed")',
    true,
  ],
  ["empty H3 replacement", "throw createError({ statusCode: 404 })", "throw createError()", true],
  [
    "guard before catch mutation",
    "throw createError({ statusCode: 404 })",
    "if (isError(error)) throw error; error = normalize(error); throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "IIFE protected throw",
    "(() => { throw createError({ statusCode: 404 }) })()",
    "throw new Error()",
    true,
  ],
  [
    "IIFE function throw",
    "(function () { throw createError({ statusCode: 404 }) })()",
    "throw new Error()",
    true,
  ],
  [
    "IIFE local return",
    "(() => { return; throw createError({ statusCode: 404 }) })()",
    "throw new Error()",
    false,
  ],
  [
    "nested block var",
    "{ var local = createError({ statusCode: 404 }) }; throw local",
    "throw new Error()",
    true,
  ],
  [
    "unreachable local write",
    "let local = createError({ statusCode: 404 }); throw local; local = new Error()",
    "throw new Error()",
    true,
  ],
  [
    "false branch local write",
    "let local = createError({ statusCode: 404 }); if (false) local = new Error(); throw local",
    "throw new Error()",
    true,
  ],
  [
    "conditional local mutation",
    "let local = createError({ statusCode: 404 }); if (change) local = new Error(); throw local",
    "throw new Error()",
    true,
  ],
  [
    "named closure local mutation",
    "let local = createError({ statusCode: 404 }); const mutate = () => { local = new Error() }; mutate(); throw local",
    "throw new Error()",
    false,
  ],
  [
    "named closure catch mutation",
    "throw createError({ statusCode: 404 })",
    "const mutate = () => { error = new Error() }; mutate(); if (isError(error)) throw error; throw createError({ statusCode: 500 })",
    true,
  ],
  [
    "IIFE unknown catch mutation",
    "throw createError({ statusCode: 404 })",
    "(() => { error = normalize(error) })(); if (isError(error)) throw error; throw createError({ statusCode: 500 })",
    true,
  ],

  [
    "invoked condition closure",
    "if (missing) throw createError({ statusCode: 404 })",
    "const mutate = () => { missing = false }; mutate(); if (missing) throw error; throw createError({ statusCode: 500 })",
    true,
  ],
  [
    "invoked catch closure",
    "throw createError({ statusCode: 404 })",
    "(() => { error = new Error() })(); if (isError(error)) throw error; throw createError({ statusCode: 500 })",
    true,
  ],
  [
    "uninvoked catch closure",
    "throw createError({ statusCode: 404 })",
    "const mutate = () => { error = new Error() }; if (isError(error)) throw error; throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "local error variable",
    "const error = createError({ statusCode: 404 }); throw error",
    "throw createError({ statusCode: 500 })",
    true,
  ],
  [
    "mutated local error variable",
    "let error = createError({ statusCode: 404 }); error = new Error(); throw error",
    "throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "local replacement variable",
    "throw createError({ statusCode: 404 })",
    "const replacement = createError({ statusCode: 500 }); throw replacement",
    true,
  ],
  [
    "callback-local condition write",
    "if (missing) throw createError({ statusCode: 404 })",
    "const inspect = () => { missing = readFlag() }; if (missing) throw error; throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "loop-local correlated condition",
    "if (missing) throw createError({ statusCode: 404 })",
    "for (let missing = false; false;) {}; if (missing) throw error; throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "loop-local true shadow",
    "throw createError({ statusCode: 404 })",
    "const preserve = true; for (let preserve = false; false;) {}; if (preserve) throw error; throw createError({ statusCode: 500 })",
    false,
  ],
  [
    "loop-local false shadow",
    "throw createError({ statusCode: 404 })",
    "const preserve = false; for (let preserve = true; false;) {}; if (preserve) throw error; throw createError({ statusCode: 500 })",
    true,
  ],
  [
    "array catch assignment",
    "throw createError({ statusCode: 404 })",
    "[error] = [null]; if (isError(error)) throw error; throw createError({ statusCode: 500 })",
    true,
  ],
  [
    "nested object catch assignment",
    "throw createError({ statusCode: 404 })",
    "({ value: [error = null] } = other); if (isError(error)) throw error; throw createError({ statusCode: 500 })",
    true,
  ],
  [
    "catch member assignment",
    "throw createError({ statusCode: 404 })",
    "error.detail = null; if (isError(error)) throw error; throw createError({ statusCode: 500 })",
    false,
  ],
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
      "server/api/account.ts": `export default defineEventHandler(async () => {
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
    "shadowed createError",
    "const createError = () => new Error(); try { throw createError({ statusCode: 404 }) } catch { throw new Error() }",
    false,
  ],
  [
    "shadowed Error",
    "const Error = class {}; try { throw createError({ statusCode: 404 }) } catch { throw new Error() }",
    false,
  ],
  [
    "parameter createError",
    "function handler(createError) { try { throw createError({ statusCode: 404 }) } catch { throw new Error() } }",
    false,
  ],
  [
    "uncalled enclosing mutation",
    "function missing() { throw createError({ statusCode: 404 }) }; function unused() { missing = () => {} }; try { missing() } catch { throw new Error() }",
    true,
  ],
  [
    "correlated enclosing replacement",
    "function missing() { throw createError({ statusCode: 404 }) }; if (change) missing = () => {}; try { if (change) missing() } catch { throw new Error() }",
    false,
  ],
  [
    "conditional enclosing replacement",
    "function missing() { throw createError({ statusCode: 404 }) }; if (change) missing = () => {}; try { missing() } catch { throw new Error() }",
    true,
  ],
  [
    "unreachable enclosing replacement",
    "function missing() { throw createError({ statusCode: 404 }) }; if (false) missing = () => {}; try { missing() } catch { throw new Error() }",
    true,
  ],
  [
    "definite enclosing replacement",
    "function missing() { throw createError({ statusCode: 404 }) }; if (true) missing = () => {}; try { missing() } catch { throw new Error() }",
    false,
  ],
  [
    "called enclosing mutation",
    "function missing() { throw createError({ statusCode: 404 }) }; function replace() { missing = () => {} }; replace(); try { missing() } catch { throw new Error() }",
    false,
  ],
  [
    "synchronous assignment value",
    "let value; try { function missing() { throw createError({ statusCode: 404 }) }; (value = missing()) } catch { throw new Error() }",
    true,
  ],
  [
    "awaited assignment value",
    "let value; try { async function missing() { throw createError({ statusCode: 404 }) }; (value = await missing()) } catch { throw new Error() }",
    true,
  ],
  [
    "synchronous assignment value.result",
    "let value; try { function missing() { throw createError({ statusCode: 404 }) }; (value.result = missing()) } catch { throw new Error() }",
    true,
  ],
  [
    "awaited assignment value.result",
    "let value; try { async function missing() { throw createError({ statusCode: 404 }) }; (value.result = await missing()) } catch { throw new Error() }",
    true,
  ],
  [
    "synchronous assignment { result: value }",
    "let value; try { function missing() { throw createError({ statusCode: 404 }) }; ({ result: value } = missing()) } catch { throw new Error() }",
    true,
  ],
  [
    "awaited assignment { result: value }",
    "let value; try { async function missing() { throw createError({ statusCode: 404 }) }; ({ result: value } = await missing()) } catch { throw new Error() }",
    true,
  ],
  [
    "enclosing helper",
    "function missing() { throw createError({ statusCode: 404 }) }; try { missing() } catch { throw new Error() }",
    true,
  ],
  [
    "replaced enclosing helper",
    "function missing() { throw createError({ statusCode: 404 }) }; missing = () => {}; try { missing() } catch { throw new Error() }",
    false,
  ],
  [
    "enclosing awaited helper",
    "async function missing() { throw createError({ statusCode: 404 }) }; try { await missing() } catch { throw new Error() }",
    true,
  ],
  [
    "shadowed enclosing helper",
    "function missing() { throw createError({ statusCode: 404 }) }; { const missing = () => {}; try { missing() } catch { throw new Error() } }",
    false,
  ],
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
  [
    "contradictory enclosing branch",
    `if (change) {
      try { if (!change) throw createError({ statusCode: 404 }) }
      catch { throw new Error() }
    }`,
    false,
  ],
  [
    "enclosing branch preserves the caught error",
    `if (missing) {
      try { throw createError({ statusCode: 404 }) }
      catch (error) { if (missing) throw error; throw new Error() }
    }`,
    false,
  ],
  [
    "enclosing alternate preserves the caught error",
    `if (missing) {} else {
      try { throw createError({ statusCode: 404 }) }
      catch (error) { if (!missing) throw error; throw new Error() }
    }`,
    false,
  ],
  [
    "enclosing loop preserves the caught error",
    `while (missing) {
      try { throw createError({ statusCode: 404 }) }
      catch (error) { if (missing) throw error; throw new Error() }
    }`,
    false,
  ],
  [
    "feasible enclosing branch masks the caught error",
    `if (missing) {
      try { throw createError({ statusCode: 404 }) }
      catch (error) { if (!missing) throw error; throw new Error() }
    }`,
    true,
  ],
  [
    "shadowed isError does not prove preservation",
    `const isError = () => false;
    try { throw createError({ statusCode: 404 }) }
    catch (error) { if (isError(error)) throw error; throw new Error() }`,
    true,
  ],
])("handles %s", async (_name, body, expected) => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: {
      "server/api/account.ts": `export default defineEventHandler(async () => { ${body} })`,
    },
  });
  expect(result.diagnostics.some((item) => item.code === "NITRO0018")).toBe(expected);
});

test("bounds correlated path exploration without affecting the next try", async () => {
  const branches = Array.from({ length: 20 }, (_, index) => `if (flag${index}) {}`).join("\n");
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: {
      "server/api/account.ts": `export default defineEventHandler(() => {
        try {
          ${branches}
          ${branches}
          throw createError({ statusCode: 404 })
        } catch { throw new Error() }
      });
      export function anotherHandler() {
        try { throw createError({ statusCode: 401 }) }
        catch { throw new Error() }
      }`,
    },
  });
  expect(result.diagnostics.filter((item) => item.code === "NITRO0018")).toHaveLength(1);
  expect(result.diagnostics.find((item) => item.code === "NITRO0018")?.message).toContain("401");
}, 5000);

test.each([false, true])("respects enclosing for initializer %s", async (enter) => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: {
      "server/api/account.ts": `export default defineEventHandler(() => {
      const enter = ${!enter};
      for (let enter = ${enter}; enter;) {
        try { throw createError({ statusCode: 404 }) }
        catch { throw new Error() }
      }
    })`,
    },
  });
  expect(result.diagnostics.some((item) => item.code === "NITRO0018")).toBe(enter);
});

test.each([
  ["throwing case test", "switch (value) { case missing(): break }", "throw new Error()", true],
  [
    "matched case skips later tests",
    'switch ("ok") { case "ok": break; case missing(): break }',
    "throw new Error()",
    false,
  ],
  [
    "default waits for case tests",
    "switch (value) { default: break; case missing(): break }",
    "throw new Error()",
    true,
  ],
  [
    "conditional replacement",
    "throw createError({ statusCode: 404 })",
    "throw isError(error) ? new Error() : error",
    true,
  ],
  [
    "conditional preservation",
    "throw createError({ statusCode: 404 })",
    "throw isError(error) ? error : new Error()",
    false,
  ],
  [
    "assignment preservation",
    "throw createError({ statusCode: 404 })",
    "let preserve; if (preserve = true) throw error; throw new Error()",
    false,
  ],
  [
    "assignment replacement",
    "throw createError({ statusCode: 404 })",
    "let preserve; if (preserve = false) throw error; throw new Error()",
    true,
  ],
  ["asserted local callee", "(missing as () => void)()", "throw new Error()", true],
  [
    "asserted preservation guard",
    "throw createError({ statusCode: 404 })",
    "if (isError(error) as boolean) throw error; throw new Error()",
    false,
  ],
  [
    "asserted switch literal",
    'switch ("ok" as string) { case "bad": throw createError({ statusCode: 404 }); case "ok": break }',
    "throw new Error()",
    false,
  ],
  [
    "asserted switch case",
    'switch ("ok") { case "bad" as string: throw createError({ statusCode: 404 }); case "ok": break }',
    "throw new Error()",
    false,
  ],
  [
    "satisfies guard",
    "throw createError({ statusCode: 404 })",
    "if (isError(error) satisfies boolean) throw error; throw new Error()",
    false,
  ],
  [
    "asserted guard callee",
    "throw createError({ statusCode: 404 })",
    "if ((isError as Function)(error)) throw error; throw new Error()",
    false,
  ],
  [
    "asserted guard argument",
    "throw createError({ statusCode: 404 })",
    "if (isError(error as Error)) throw error; throw new Error()",
    false,
  ],
  [
    "asserted error factory",
    "throw (createError as Function)({ statusCode: 404 })",
    "throw new (Error as ErrorConstructor)()",
    true,
  ],
  ["asserted rethrow", "throw createError({ statusCode: 404 })", "throw error as Error", false],
])("handles %s", async (_name, body, handler, expected) => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: {
      "server/api/account.ts": `export default defineEventHandler(() => {
        function missing() { throw createError({ statusCode: 404 }) }
        try { ${body} } catch (error) { ${handler} }
      })`,
    },
  });
  expect(result.diagnostics.some((item) => item.code === "NITRO0018")).toBe(expected);
});

test.each([
  ["const original = error", "original"],
  ["const original = error as Error", "original"],
  ["let original; original = error", "original"],
  ["const first = error; const original = first", "original"],
])("preserves caught error aliases through %s", async (declaration, alias) => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: {
      "server/api/account.ts": `export default defineEventHandler(() => {
        try { throw createError({ statusCode: 404 }) }
        catch (error) { ${declaration}; if (isError(${alias})) throw ${alias}; throw new Error() }
      })`,
    },
  });
  expect(result.diagnostics.some((item) => item.code === "NITRO0018")).toBe(false);
});

test.each([
  ["unmatched case", 'switch ("a") { case "b": MASK }', false],
  ["matched case", 'switch ("a") { case "a": MASK }', true],
  ["fallthrough", 'switch ("a") { case "a": log(); case "b": MASK }', true],
  ["break before target", 'switch ("a") { case "a": break; case "b": MASK }', false],
  ["return before target", 'switch ("a") { case "a": return; MASK }', false],
  ["unreachable default", 'switch ("a") { default: MASK; case "a": break }', false],
  ["matched default", 'switch ("a") { case "b": break; default: MASK }', true],
  ["nested unmatched case", 'switch ("a") { case "a": switch ("b") { case "a": MASK } }', false],
  [
    "preceding case state",
    'let preserve = false; switch ("a") { case "a": preserve = true; case "b": if (!preserve) { MASK } }',
    false,
  ],
  [
    "case test throws",
    'function fail() { throw new Error() }; switch ("a") { case fail(): MASK }',
    false,
  ],
])("respects enclosing switch %s", async (_name, source, expected) => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: {
      "server/api/account.ts": `export default defineEventHandler(() => {
        ${source.replace("MASK", "try { throw createError({ statusCode: 404 }) } catch { throw new Error() }")}
      })`,
    },
  });
  expect(result.diagnostics.some((item) => item.code === "NITRO0018")).toBe(expected);
});

test("keeps the unmatched path for a possibly NaN switch identifier", async () => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: {
      "server/api/account.ts": `export default defineEventHandler(() => {
        const value = NaN;
        try {
          switch (value) { case value: break; default: throw createError({ statusCode: 404 }) }
        } catch { throw new Error() }
      })`,
    },
  });
  expect(result.diagnostics.some((item) => item.code === "NITRO0018")).toBe(true);
});

test.each([
  [
    "returned HTTP error",
    "function make() { return createError({ statusCode: 404 }) }; throw make()",
    true,
  ],
  [
    "returned error alias",
    "function make() { const error = createError({ statusCode: 404 }); return error }; throw make()",
    true,
  ],
  ["returned native error", "function make() { return new Error() }; throw make()", false],
  ["throwing default", "function load(value = notFound()) {}; load()", true],
  [
    "unreturned HTTP error",
    "function make() { createError({ statusCode: 404 }) }; throw make()",
    false,
  ],
  ["arrow return", "const make = () => createError({ statusCode: 404 }); throw make()", true],
  ["skipped default", "function load(value = notFound()) {}; load(1)", false],
  ["undefined default", "function load(value = notFound()) {}; load(undefined)", true],
  ["target object", "notFound().value = 1", true],
  ["target key", "const target = {}; target[notFound()] = 1", true],
  ["target before RHS", "function fail() { throw new Error() }; fail().value = notFound()", false],
  ["logical left", "const value = notFound() && true", true],
  ["logical right", "const value = true && notFound()", true],
  ["skipped logical right", "const value = false && notFound()", false],
  ["skipped alternative", "const value = true || notFound()", false],
  ["nullish right", "const value = null ?? notFound()", true],
  ["skipped nullish right", "const value = false ?? notFound()", false],
] as const)("models expression execution: %s", async (_name, source, expected) => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: {
      "server/api/account.ts": `export default defineEventHandler(() => {
        function notFound() { throw createError({ statusCode: 404 }) }
        try { ${source} } catch { throw new Error() }
      })`,
    },
  });
  expect(result.diagnostics.some((item) => item.code === "NITRO0018")).toBe(expected);
});

test.each([
  ["const alias = error; alias.statusCode = 500; throw error", true],
  ["const alias = error; error.statusCode = 500; throw alias", true],
  ["const alias = error; { const error = new Error(); alias.statusCode = 500 }; throw error", true],
  [
    "let alias = error; alias = createError({ statusCode: 403 }); alias.statusCode = 500; throw error",
    false,
  ],
  ["const alias = error; if (flag) { alias.statusCode = 500; return }; throw error", false],
] as const)("preserves error identity: %s", async (source, expected) => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: {
      "server/api/account.ts": `export default defineEventHandler(() => {
        try { throw createError({ statusCode: 404 }) } catch (error) { ${source} }
      })`,
    },
  });
  expect(result.diagnostics.some((item) => item.code === "NITRO0018")).toBe(expected);
});

test.each([
  ['const key = "a"; switch (key) { case "b": MASK }', false],
  ["const key = 1; switch (key) { case 1: const key = 2; MASK }", true],
  ['const key = "a"; switch (key) { case "a": MASK }', true],
  ['const key = "a"; switch (key) { case key: break; default: MASK }', false],
  [
    "const enabled = true; switch (2) { case 1: const enabled = false; break; case 2: if (enabled) { MASK } }",
    false,
  ],
  ["switch (2) { case 1: const enabled = false; break; case 2: typeof enabled; MASK }", false],
  ["switch (1) { case 1: const enabled = true; case 2: if (enabled) { MASK } }", true],
] as const)("models enclosing switch values and scope: %s", async (source, expected) => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: {
      "server/api/account.ts": `export default defineEventHandler(() => {
        ${source.replace("MASK", "try { throw createError({ statusCode: 404 }) } catch { throw new Error() }")}
      })`,
    },
  });
  expect(result.diagnostics.some((item) => item.code === "NITRO0018")).toBe(expected);
});

test("preserves a returned HTTP error through a normal finalizer", async () => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: {
      "server/api/account.ts": `export default defineEventHandler(() => {
        function make() { try { return createError({ statusCode: 404 }) } finally { cleanup() } }
        try { throw make() } catch { throw new Error() }
      })`,
    },
  });
  expect(result.diagnostics.some((item) => item.code === "NITRO0018")).toBe(true);
});

test.each([
  ["named factory", 'import { createError } from "h3"', "createError", "", true],
  ["aliased factory", 'import { createError as httpError } from "h3"', "httpError", "", true],
  [
    "imported guard",
    'import { createError, isError } from "h3"',
    "createError",
    "if (isError(error)) throw error;",
    false,
  ],
  [
    "aliased guard",
    'import { createError as httpError, isError as isHttpError } from "h3"',
    "httpError",
    "if (isHttpError(error)) throw error;",
    false,
  ],
  ["unrelated factory", 'import { createError } from "other"', "createError", "", false],
  [
    "unrelated guard",
    'import { createError } from "h3"; import { isError } from "other"',
    "createError",
    "if (isError(error)) throw error;",
    true,
  ],
  ["shadowed factory", 'import { createError } from "h3"', "createError", "", false, "createError"],
  [
    "shadowed guard",
    'import { createError, isError } from "h3"',
    "createError",
    "if (isError(error)) throw error;",
    true,
    "isError",
  ],
])("handles %s bindings", async (_name, imports, factory, guard, reports, parameter = "") => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: {
      "api/account.ts": `${imports}
        export default defineEventHandler((${parameter}) => {
          try { throw ${factory}({ statusCode: 404 }) }
          catch (error) { ${guard} throw new Error() }
        })`,
    },
  });
  expect(result.diagnostics.some((item) => item.code === "NITRO0018")).toBe(reports);
});

test.each([
  [
    "returned alias",
    "function pass(value) { return value }; function preserve(value) { if (isError(value)) throw value }",
    "preserve(pass(error))",
    false,
  ],
  [
    "multiple arguments",
    "function pass(value) { return value }; function preserve(first, second) { if (isError(first)) throw first }",
    "preserve(pass(error), pass(false))",
    false,
  ],
  [
    "argument snapshot",
    "function preserve(first, second) { if (isError(first)) throw first }",
    "preserve(error, error = new Error())",
    false,
  ],
  [
    "shared identity",
    "function pass(value) { return value }; function change(value) { value.statusCode = 500 }",
    "change(pass(error)); throw error",
    true,
  ],
])("propagates supplied values through %s", async (_name, helpers, handler, reports) => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: {
      "api/account.ts": `export default defineEventHandler(() => {
        ${helpers}
        try { throw createError({ statusCode: 404 }) }
        catch (error) { ${handler}; throw new Error() }
      })`,
    },
  });
  expect(result.diagnostics.some((item) => item.code === "NITRO0018")).toBe(reports);
});

test.each([
  [
    "declaration",
    "function missing() {}",
    "const missing = () => { throw createError({ statusCode: 404 }) }",
    false,
  ],
  [
    "initializer",
    "const missing = () => {}",
    "function missing() { throw createError({ statusCode: 404 }) }",
    false,
  ],
  [
    "outer throwing helper",
    "function missing() { throw createError({ statusCode: 404 }) }",
    "const missing = () => {}",
    true,
  ],
  [
    "outer helper replacement",
    "let missing = () => {}; missing = () => { throw createError({ statusCode: 404 }) }",
    "function missing() {}",
    true,
  ],
])("resolves closed-over helpers by lexical binding: %s", async (_, outer, inner, reports) => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: {
      "server/api/account.ts": `export default defineEventHandler(() => {
        ${outer}
        function invoke() { missing() }
        {
          ${inner}
          try { invoke() } catch { throw new Error() }
        }
      })`,
    },
  });
  expect(result.diagnostics.some((item) => item.code === "NITRO0018")).toBe(reports);
});

test.each(["in", "of"])(
  "evaluates enclosing for-%s sources before entering the body",
  async (operator) => {
    const result = await runRuleFixture({
      framework: "nitro",
      rule: noHttpErrorMasking,
      files: {
        "server/api/account.ts": `export default defineEventHandler(() => {
        function fail() { throw new Error() }
        for (const item ${operator} fail()) {
          try { throw createError({ statusCode: 404 }) } catch { throw new Error() }
        }
      })`,
      },
    });
    expect(result.diagnostics).toEqual([]);
  },
);

test.each([
  [
    "status equality guard",
    "try { throw createError({ statusCode: 404 }) } catch (error) { if (error.statusCode === 404) throw error; throw new Error() }",
    0,
  ],
  [
    "computed status guard",
    "try { throw createError({ status: 404 }) } catch (error) { if (error['status'] === 404) throw error; throw new Error() }",
    0,
  ],
  [
    "status range guard",
    "try { throw createError({ statusCode: 404 }) } catch (error) { if (error.statusCode >= 400 && error.statusCode < 500) throw error; throw new Error() }",
    0,
  ],
  [
    "status guard leaves masking reachable",
    "try { throw createError({ statusCode: 403 }) } catch (error) { if (error.statusCode === 404) throw error; throw new Error() }",
    1,
  ],
  [
    "status mutation before guard",
    "try { throw createError({ statusCode: 404 }) } catch (error) { error.statusCode = 403; if (error.statusCode === 404) throw error; throw new Error() }",
    1,
  ],
  [
    "let TDZ",
    "try { missing; throw createError({ statusCode: 404 }); let missing } catch { throw new Error() }",
    0,
  ],
  [
    "const TDZ",
    "try { missing; throw createError({ statusCode: 404 }); const missing = 1 } catch { throw new Error() }",
    0,
  ],
  [
    "class TDZ",
    "try { Missing; throw createError({ statusCode: 404 }); class Missing {} } catch { throw new Error() }",
    0,
  ],
  [
    "initialized class",
    "try { class Missing {}; Missing; throw createError({ statusCode: 404 }) } catch { throw new Error() }",
    1,
  ],
  [
    "initialized let",
    "try { let missing; missing; throw createError({ statusCode: 404 }) } catch { throw new Error() }",
    1,
  ],
  [
    "enclosing TDZ",
    "missing; try { throw createError({ statusCode: 404 }) } catch { throw new Error() }; let missing",
    0,
  ],
  [
    "unreachable catch",
    "try {} catch { try { throw createError({ statusCode: 404 }) } catch { throw new Error() } }",
    0,
  ],
  [
    "reachable catch",
    "try { throw new Error() } catch { try { throw createError({ statusCode: 404 }) } catch { throw new Error() } }",
    1,
  ],
  [
    "enclosing catch binding",
    "try { throw createError({ statusCode: 404 }) } catch (error) { const innerCatch = true;\n try { throw error } catch { throw new Error() }\n }",
    2,
  ],
  [
    "named expression recursion",
    "const missing = function missing(stop) { if (stop) throw createError({ statusCode: 404 }); return missing(true) }; try { missing(false) } catch { throw new Error() }",
    1,
  ],
  [
    "distinct expression self name",
    "const missing = function self(stop) { if (stop) throw createError({ statusCode: 404 }); return self(true) }; try { missing(false) } catch { throw new Error() }",
    1,
  ],
  [
    "self binding survives outer replacement",
    "let missing = function self(stop) { missing = () => {}; if (stop) throw createError({ statusCode: 404 }); return self(true) }; try { missing(false) } catch { throw new Error() }",
    1,
  ],
])("tracks review regression: %s", async (_name, body, count) => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: { "server/api/account.ts": `export default defineEventHandler(() => { ${body} })` },
  });
  expect(result.diagnostics.filter((item) => item.code === "NITRO0018")).toHaveLength(count);
});

test.each([
  [
    "closure with a generic outer error",
    "const saved = new Error(); function fail() { throw saved }; { const saved = createError({ statusCode: 404 }); try { fail() } catch { throw new Error() } }",
    false,
  ],
  [
    "closure with an HTTP outer error",
    "const saved = createError({ statusCode: 404 }); function fail() { throw saved }; { const saved = new Error(); try { fail() } catch { throw new Error() } }",
    true,
  ],
  [
    "constant status",
    "const NOT_FOUND = 404; try { throw createError({ statusCode: NOT_FOUND }) } catch { throw new Error() }",
    true,
  ],
  [
    "object default",
    "function notFound() { throw createError({ statusCode: 404 }) }; try { const { value = notFound() } = {} } catch { throw new Error() }",
    true,
  ],
  [
    "unused object default",
    "function notFound() { throw createError({ statusCode: 404 }) }; try { const { value = notFound() } = { value: 1 } } catch { throw new Error() }",
    false,
  ],
  [
    "array default",
    "function notFound() { throw createError({ statusCode: 404 }) }; try { const [value = notFound()] = [] } catch { throw new Error() }",
    true,
  ],
  [
    "constructor throw",
    "function NotFound() { throw createError({ statusCode: 404 }) }; try { new NotFound() } catch { throw new Error() }",
    true,
  ],
  [
    "nonconstructible arrow",
    "const NotFound = () => { throw createError({ statusCode: 404 }) }; try { new NotFound() } catch { throw new Error() }",
    false,
  ],
  [
    "coercive equality",
    'try { throw createError({ statusCode: 404 }) } catch (error) { if (error.statusCode == "404") throw error; throw new Error() }',
    false,
  ],
  [
    "coercive range",
    'try { throw createError({ statusCode: 404 }) } catch (error) { if (error.statusCode >= "400") throw error; throw new Error() }',
    false,
  ],
  [
    "computed status write",
    'const key = "statusCode"; try { throw createError({ statusCode: 404 }) } catch (error) { error[key] = 403; if (error.statusCode === 404) throw error; throw new Error() }',
    true,
  ],
])("respects %s", async (_name, source, reports) => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: { "server/api/account.ts": `export default defineEventHandler(() => { ${source} })` },
  });
  expect(result.diagnostics.some((item) => item.code === "NITRO0018")).toBe(reports);
});

test.each([
  [
    "switch class temporal dead zone",
    `switch (1) { case 1: Later; try { throw createError({ statusCode: 404 }) } catch { throw new Error() }; break; case 2: class Later {} }`,
  ],
  [
    "immutable function self-binding",
    `const fail = function self() { self = () => { throw createError({ statusCode: 404 }) }; self() }; try { fail() } catch { throw new Error() }`,
  ],
])("does not report unreachable masking after %s", async (_name, source) => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: { "server/api/account.ts": `export default defineEventHandler(() => { ${source} })` },
  });
  expect(result.diagnostics).toHaveLength(0);
});

test("evaluates computed destructuring keys", async () => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: {
      "server/api/account.ts": `function missing() { throw createError({ statusCode: 404 }) }
        try { const { [missing()]: value } = {} } catch { throw new Error() }`,
    },
  });
  expect(result.diagnostics.map((item) => item.code)).toContain("NITRO0018");
});

test.each([
  ["namespace import", "throw h3.createError({ statusCode: 404 })", "throw new Error()", true],
  [
    "shadowed namespace",
    "const h3 = { createError: () => new Error() }; throw h3.createError()",
    "throw new Error()",
    false,
  ],
  [
    "terminated static initialization",
    "class Failure { static first = (() => { throw new Error() })(); static second = missing() }",
    "throw new Error()",
    false,
  ],
  [
    "class expression",
    "const Failure = class { static value = missing() }",
    "throw new Error()",
    true,
  ],
  [
    "captured status key",
    "missing()",
    'let key = "statusCode"; error[key] = (key = "other", 403); if (error.statusCode === 404) throw error; throw new Error()',
    true,
  ],
  [
    "captured unrelated key",
    "missing()",
    'let key = "other"; error[key] = (key = "statusCode", 403); if (error.statusCode === 404) throw error; throw new Error()',
    false,
  ],
  [
    "computed destructuring",
    'const key = "value"; const { [key]: value = missing() } = { [key]: 1 }',
    "throw new Error()",
    false,
  ],
  ["string iterable default", 'const [first, second = missing()] = "x"', "throw new Error()", true],
  [
    "namespace guard",
    "throw h3.createError({ statusCode: 404 })",
    "if (h3.isError(error)) throw error; throw new Error()",
    false,
  ],
  ["static field", "class Failure { static value = missing() }", "throw new Error()", true],
  ["static block", "class Failure { static { missing() } }", "throw new Error()", true],
  ["instance field", "class Failure { value = missing() }", "throw new Error()", false],
  [
    "destructured object",
    "missing()",
    "function preserve({ value }) { if (isError(value)) throw value }; preserve({ value: error }); throw new Error()",
    false,
  ],
  [
    "destructured array",
    "missing()",
    "function preserve([value]) { if (isError(value)) throw value }; preserve([error]); throw new Error()",
    false,
  ],
])("models %s in HTTP error paths", async (_name, protectedBody, catchBody, reports) => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: {
      "server/api/account.ts": `import * as h3 from 'h3';
      export default defineEventHandler(() => {
        function missing() { throw createError({ statusCode: 404 }) }
        try { ${protectedBody} } catch (error) { ${catchBody} }
      })`,
    },
  });
  expect(result.diagnostics.some((item) => item.code === "NITRO0018")).toBe(reports);
});

test.each([
  [
    "BigInt expression",
    "try { 1n; throw createError({ statusCode: 404 }) } catch { throw new Error() }",
    1,
  ],
  [
    "BigInt loop binding",
    "const value = 1n; try { while (unknown) { throw createError({ statusCode: 404 }) } } catch { throw new Error() }",
    1,
  ],
  [
    "class static field self-reference",
    "try { class Failure { static self = Failure; static value = (() => { throw createError({ statusCode: 404 }) })() } } catch { throw new Error() }",
    1,
  ],
  [
    "class static block self-reference",
    "try { class Failure { static { Failure; throw createError({ statusCode: 404 }) } } } catch { throw new Error() }",
    1,
  ],
  [
    "named class expression self-reference",
    "try { const Failure = class Failure { static self = Failure; static value = (() => { throw createError({ statusCode: 404 }) })() } } catch { throw new Error() }",
    1,
  ],
  [
    "class computed key TDZ",
    "try { class Failure { [Failure]() {}; static { throw createError({ statusCode: 404 }) } } } catch { throw new Error() }",
    0,
  ],
  [
    "named class expression computed key TDZ",
    "try { const Failure = class Failure { [Failure]() {}; static { throw createError({ statusCode: 404 }) } } } catch { throw new Error() }",
    0,
  ],
  [
    "anonymous class outer binding TDZ",
    "try { const Failure = class { static self = Failure; static { throw createError({ statusCode: 404 }) } } } catch { throw new Error() }",
    0,
  ],
  [
    "closed-over true condition",
    "const preserve = true; function keep(e) { if (preserve) throw e } { const preserve = false; try { throw createError({ statusCode: 404 }) } catch (error) { keep(error); throw new Error() } }",
    0,
  ],
  [
    "closed-over false condition",
    "const preserve = false; function keep(e) { if (preserve) throw e } { const preserve = true; try { throw createError({ statusCode: 404 }) } catch (error) { keep(error); throw new Error() } }",
    1,
  ],
  [
    "closed-over correlated condition",
    "function keep(e) { if (preserve) throw e } if (preserve) { const preserve = false; try { throw createError({ statusCode: 404 }) } catch (error) { keep(error); throw new Error() } }",
    0,
  ],
  [
    "finalizer after false assignment",
    "let flag = true; try { flag = false } finally { try { if (flag) throw createError({ statusCode: 404 }) } catch { throw new Error() } }",
    0,
  ],
  [
    "finalizer after true assignment",
    "let flag = false; try { flag = true } finally { try { if (flag) throw createError({ statusCode: 404 }) } catch { throw new Error() } }",
    1,
  ],
  [
    "finalizer after catch assignment",
    "let flag = false; try { throw new Error() } catch { flag = true } finally { try { if (flag) throw createError({ statusCode: 404 }) } catch { throw new Error() } }",
    1,
  ],
  [
    "finalizer after return",
    "let flag = false; try { flag = true; return } finally { try { if (flag) throw createError({ statusCode: 404 }) } catch { throw new Error() } }",
    1,
  ],
  [
    "empty array iteration",
    "try { for (const item of []) throw createError({ statusCode: 404 }) } catch { throw new Error() }",
    0,
  ],
  [
    "empty object iteration",
    "try { for (const item in {}) throw createError({ statusCode: 404 }) } catch { throw new Error() }",
    1,
  ],
  [
    "empty string iteration",
    "try { for (const item of '') throw createError({ statusCode: 404 }) } catch { throw new Error() }",
    1,
  ],
  [
    "nonempty array iteration",
    "try { for (const item of [1]) throw createError({ statusCode: 404 }) } catch { throw new Error() }",
    1,
  ],
  [
    "nonempty object iteration",
    "try { for (const item in { key: 1 }) throw createError({ statusCode: 404 }) } catch { throw new Error() }",
    1,
  ],
])("respects reviewed execution path: %s", async (_name, body, count) => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: { "server/api/account.ts": `export default defineEventHandler(() => { ${body} })` },
  });
  expect(result.diagnostics.filter((item) => item.code === "NITRO0018")).toHaveLength(count);
});

test.each([
  [
    "literal parameter",
    "function fail(code) { throw createError({ statusCode: code }) }; try { fail(404) } catch { throw new Error() }",
    1,
  ],
  [
    "default literal parameter",
    "function fail(code = 404) { throw createError({ statusCode: code }) }; try { fail() } catch { throw new Error() }",
    1,
  ],
  [
    "server status parameter",
    "function fail(code) { throw createError({ statusCode: code }) }; try { fail(500) } catch { throw new Error() }",
    0,
  ],
  [
    "recursive literal restoration",
    "function fail(code) { if (code === 404) fail(500); if (code === 404) throw createError({ statusCode: code }) }; try { fail(404) } catch { throw new Error() }",
    1,
  ],
  [
    "helper declaration alias",
    "function missing() { throw createError({ statusCode: 404 }) }; const fail = missing; try { fail() } catch { throw new Error() }",
    1,
  ],
  [
    "helper assignment alias",
    "function missing() { throw createError({ statusCode: 404 }) }; let fail; fail = missing; try { fail() } catch { throw new Error() }",
    1,
  ],
  [
    "replaced helper alias",
    "function missing() { throw createError({ statusCode: 404 }) }; let fail = missing; fail = () => {}; try { fail() } catch { throw new Error() }",
    0,
  ],
  [
    "await array operand",
    "function missing() { throw createError({ statusCode: 404 }) }; try { await [missing()] } catch { throw new Error() }",
    1,
  ],
  [
    "await object operand",
    "function missing() { throw createError({ statusCode: 404 }) }; try { await ({ value: missing() }) } catch { throw new Error() }",
    1,
  ],
  [
    "inherited object property",
    "Object.prototype.inherited = 1; try { for (const key in {}) throw createError({ statusCode: 404 }) } catch { throw new Error() }",
    1,
  ],
  [
    "replaced array iterator",
    "Array.prototype[Symbol.iterator] = function* () { yield 1 }; try { for (const item of []) throw createError({ statusCode: 404 }) } catch { throw new Error() }",
    1,
  ],
  [
    "replaced string iterator",
    "String.prototype[Symbol.iterator] = function* () { yield 1 }; try { for (const item of '') throw createError({ statusCode: 404 }) } catch { throw new Error() }",
    1,
  ],
])("preserves reviewed helper and iteration behavior: %s", async (_name, body, count) => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: {
      "server/api/account.ts": `export default defineEventHandler(async () => { ${body} })`,
    },
  });
  expect(result.diagnostics.filter((item) => item.code === "NITRO0018")).toHaveLength(count);
});

test.each([
  [
    "object alias",
    "const { value: original } = { value: error }; if (isError(original)) throw original; throw new Error()",
    0,
  ],
  [
    "array alias",
    "const [original] = [error]; if (isError(original)) throw original; throw new Error()",
    0,
  ],
  [
    "nested alias",
    "const { value: [original] } = { value: [error] }; if (isError(original)) throw original; throw new Error()",
    0,
  ],
  ["increment to 500", "error.statusCode++; throw error", 1],
  ["prefix increment to 500", "++error.statusCode; throw error", 1],
  ["computed increment", "const key = 'statusCode'; error[key]++; throw error", 1],
  ["decrement preserves", "error.statusCode--; throw error", 0],
])("tracks reviewed catch mutations: %s", async (_name, body, count) => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: {
      "server/api/account.ts": `export default defineEventHandler(() => { try { throw createError({ statusCode: 499 }) } catch (error) { ${body} } })`,
    },
  });
  expect(result.diagnostics.filter((item) => item.code === "NITRO0018")).toHaveLength(count);
});

test.each([
  [
    "multiple spread values",
    "function fail(first, code = 404) { throw createError({ statusCode: code }) }; try { fail(...[1, 500]) } catch { throw new Error() }",
    0,
  ],
  [
    "sparse spread default",
    "function fail(code = 404) { throw createError({ statusCode: code }) }; try { fail(...[,]) } catch { throw new Error() }",
    1,
  ],
  [
    "empty spread default",
    "function fail(code = 404) { throw createError({ statusCode: code }) }; try { fail(...[]) } catch { throw new Error() }",
    1,
  ],
  [
    "trailing argument",
    "function fail(code = 404) { throw createError({ statusCode: code }) }; try { fail(...[], 500) } catch { throw new Error() }",
    0,
  ],
  [
    "nested spread",
    "function fail(first, code = 404) { throw createError({ statusCode: code }) }; try { fail(...[1, ...[500]]) } catch { throw new Error() }",
    0,
  ],
  [
    "unknown spread default",
    "function fail(code = 404) { throw createError({ statusCode: code }) }; try { fail(...args) } catch { throw new Error() }",
    1,
  ],
  [
    "replaced array iterator",
    "Array.prototype[Symbol.iterator] = function* () { yield 404 }; function fail(code) { throw createError({ statusCode: code }) }; try { fail(...[500]) } catch { throw new Error() }",
    1,
  ],
  [
    "replaced array iterator preserving server status",
    "Array.prototype[Symbol.iterator] = function* () { yield 500 }; function fail(code) { throw createError({ statusCode: code }) }; try { fail(...[404]) } catch { throw new Error() }",
    0,
  ],
])("tracks reviewed spread arguments: %s", async (_name, body, count) => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: { "server/api/account.ts": `export default defineEventHandler(() => { ${body} })` },
  });
  expect(result.diagnostics.filter((item) => item.code === "NITRO0018")).toHaveLength(count);
});

test.each([
  [
    "closed-over error assignment",
    "let saved; function set() { saved = createError({ statusCode: 404 }) }; try { set(); throw saved } catch { throw new Error() }",
    1,
  ],
  [
    "skipped logical and assignment",
    "let run = false; function notFound() { throw createError({ statusCode: 404 }) }; try { run &&= notFound() } catch { throw new Error() }",
    0,
  ],
  [
    "skipped logical or assignment",
    "let run = true; function notFound() { throw createError({ statusCode: 404 }) }; try { run ||= notFound() } catch { throw new Error() }",
    0,
  ],
  [
    "skipped nullish assignment",
    "let run = false; function notFound() { throw createError({ statusCode: 404 }) }; try { run ??= notFound() } catch { throw new Error() }",
    0,
  ],
  [
    "entered logical assignment",
    "let run = true; function notFound() { throw createError({ statusCode: 404 }) }; try { run &&= notFound() } catch { throw new Error() }",
    1,
  ],
  [
    "nested try in later while iteration",
    "let ready = false; while (true) { if (ready) { try { throw createError({ statusCode: 404 }) } catch { throw new Error() } } ready = true }",
    1,
  ],
  [
    "nested try in later for iteration",
    "let ready = false; for (;;) { if (ready) { try { throw createError({ statusCode: 404 }) } catch { throw new Error() } } ready = true }",
    1,
  ],
  [
    "nested try after two iterations",
    "let count = 0; while (count < 3) { if (count === 2) { try { throw createError({ statusCode: 404 }) } catch { throw new Error() } } count++ }",
    1,
  ],
  [
    "nested try in later do-while iteration",
    "let ready = false; do { if (ready) { try { throw createError({ statusCode: 404 }) } catch { throw new Error() } } ready = true } while (true)",
    1,
  ],
  [
    "nested try after error status changes",
    "let error = createError({ statusCode: 500 }); let ready = false; while (true) { if (ready) { try { throw error } catch { throw new Error() } } error.statusCode = 404; ready = true }",
    1,
  ],
  [
    "continue to outer loop never enters nested try",
    "outer: while (true) { while (true) { continue outer; try { throw createError({ statusCode: 404 }) } catch { throw new Error() } } }",
    0,
  ],
  [
    "unreachable later iteration after return",
    "let ready = false; while (true) { if (ready) { try { throw createError({ statusCode: 404 }) } catch { throw new Error() } } else return; ready = true }",
    0,
  ],
])("tracks reviewed closure, assignment, and iteration paths: %s", async (_name, body, count) => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: { "server/api/account.ts": `export default defineEventHandler(() => { ${body} })` },
  });
  expect(result.diagnostics.filter((item) => item.code === "NITRO0018")).toHaveLength(count);
});

test.each([
  [
    "adopted async rejection",
    "async function missing() { throw createError({ statusCode: 404 }) }; async function load() { return missing() }; try { await load() } catch { throw new Error() }",
    1,
  ],
  [
    "nested argument Promise is not adopted",
    "async function missing() { throw createError({ statusCode: 404 }) }; function consume(_) { return Promise.resolve() }; async function load() { return consume(missing()) }; try { await load() } catch { throw new Error() }",
    0,
  ],
  [
    "awaited explicit rejection",
    "try { await Promise.reject(createError({ statusCode: 404 })) } catch { throw new Error() }",
    1,
  ],
  [
    "returned explicit rejection is adopted",
    "async function load() { return Promise.reject(createError({ statusCode: 404 })) }; try { await load() } catch { throw new Error() }",
    1,
  ],
  [
    "computed HTTP status key",
    "try { throw createError({ ['statusCode']: 404 }) } catch { throw new Error() }",
    1,
  ],
  [
    "computed numeric HTTP status",
    "try { throw createError({ statusCode: 400 + 4 }) } catch { throw new Error() }",
    1,
  ],
  [
    "constructor call of arrow throws before client error",
    "try { new (() => {}); throw createError({ statusCode: 404 }) } catch { throw new Error() }",
    0,
  ],
  [
    "tagged template substitution throws client error",
    "function missing() { throw createError({ statusCode: 404 }) }; try { tag`${missing()}` } catch { throw new Error() }",
    1,
  ],
  [
    "tagged template function throws client error",
    "function tag() { throw createError({ statusCode: 404 }) }; try { tag`value` } catch { throw new Error() }",
    1,
  ],
  [
    "for-of binding reaches nested try",
    "for (const code of [404]) { try { throw createError({ statusCode: code }) } catch { throw new Error() } }",
    1,
  ],
  [
    "for-of cannot assign to existing const",
    "const code = 500; for (code of [404]) { try { throw createError({ statusCode: code }) } catch { throw new Error() } }",
    0,
  ],
  [
    "optional call of known function",
    "function missing() { throw createError({ statusCode: 404 }) }; try { missing?.() } catch { throw new Error() }",
    1,
  ],
  ["optional call on nullish object", "try { null?.missing() } catch { throw new Error() }", 0],
  [
    "optional chain skips argument evaluation",
    "function missing() { throw createError({ statusCode: 404 }) }; try { null?.call(missing()) } catch { throw new Error() }",
    0,
  ],
  [
    "optional chain skips computed key evaluation",
    "function missing() { throw createError({ statusCode: 404 }) }; try { null?.[missing()] } catch { throw new Error() }",
    0,
  ],
  [
    "long optional chain skips argument evaluation",
    "function missing() { throw createError({ statusCode: 404 }) }; try { null?.target.call(missing()) } catch { throw new Error() }",
    0,
  ],
  [
    "long optional chain skips computed key evaluation",
    "function missing() { throw createError({ statusCode: 404 }) }; try { null?.target[missing()] } catch { throw new Error() }",
    0,
  ],
  [
    "unary guard preserves caught error",
    "try { throw createError({ statusCode: 404 }) } catch (error) { const preserve = !false; if (preserve) throw error; throw new Error() }",
    0,
  ],
  [
    "empty destructuring throws before client error",
    "try { const {} = null; throw createError({ statusCode: 404 }) } catch { throw new Error() }",
    0,
  ],
  [
    "later parameter is unavailable in earlier default",
    "function fail(a = b, b) { throw createError({ statusCode: 404 }) }; try { fail() } catch { throw new Error() }",
    0,
  ],
  [
    "destructured names retain independent values",
    "try { throw createError({ statusCode: 404 }) } catch (error) { const { preserved, decoy } = { preserved: false, decoy: error }; if (isError(preserved)) throw preserved; throw new Error() }",
    1,
  ],
  [
    "compound status update reaches 500",
    "try { throw createError({ statusCode: 404 }) } catch (error) { error.statusCode += 96; throw error }",
    1,
  ],
  [
    "primitive replacement masks client error",
    "try { throw createError({ statusCode: 404 }) } catch { throw 'failed' }",
    1,
  ],
  [
    "plain object replacement masks client error",
    "try { throw createError({ statusCode: 404 }) } catch { throw { message: 'failed' } }",
    1,
  ],
  [
    "subtraction compound status reaches 500",
    "try { throw createError({ statusCode: 404 }) } catch (error) { error.statusCode = 501; error.statusCode -= 1; throw error }",
    1,
  ],
  [
    "object shorthand method",
    "function missing() { throw createError({ statusCode: 404 }) }; const helpers = { missing }; try { helpers.missing() } catch { throw new Error() }",
    1,
  ],
  [
    "method following unknown spread",
    "const helpers = { ...unknown, missing() { throw createError({ statusCode: 404 }) } }; try { helpers.missing() } catch { throw new Error() }",
    1,
  ],
  [
    "method replacement through helper parameter",
    "const helpers = { missing() { throw createError({ statusCode: 404 }) } }; function replace(target) { target.missing = () => { throw new Error() } }; replace(helpers); try { helpers.missing() } catch { throw new Error() }",
    0,
  ],
  [
    "unawaited async call",
    "async function missing() { throw createError({ statusCode: 404 }) }; try { missing() } catch { throw new Error() }",
    0,
  ],
  [
    "local object method throws intentional error",
    "const helpers = { missing() { throw createError({ statusCode: 404 }) } }; try { helpers.missing() } catch { throw new Error() }",
    1,
  ],
  [
    "replaced object method does not throw intentional error",
    "const helpers = { missing() { throw createError({ statusCode: 404 }) } }; helpers.missing = () => { throw new Error() }; try { helpers.missing() } catch { throw new Error() }",
    0,
  ],
  [
    "replaced object method through alias does not throw intentional error",
    "const helpers = { missing() { throw createError({ statusCode: 404 }) } }; const alias = helpers; alias.missing = () => { throw new Error() }; try { helpers.missing() } catch { throw new Error() }",
    0,
  ],
  [
    "nullish access stops before intentional error",
    "try { null.value; throw createError({ statusCode: 404 }) } catch { throw new Error() }",
    0,
  ],
  [
    "undefined access stops before intentional error",
    "try { undefined.value; throw createError({ statusCode: 404 }) } catch { throw new Error() }",
    0,
  ],
  [
    "earlier argument changes iterator to client status",
    "function change() { Array.prototype[Symbol.iterator] = function* () { yield 404 }; return 0 }; function fail(_, code) { throw createError({ statusCode: code }) }; try { fail(change(), ...[500]) } catch { throw new Error() }",
    1,
  ],
  [
    "earlier argument changes iterator to server status",
    "function change() { Array.prototype[Symbol.iterator] = function* () { yield 500 }; return 0 }; function fail(_, code) { throw createError({ statusCode: code }) }; try { fail(change(), ...[404]) } catch { throw new Error() }",
    0,
  ],
])("tracks reviewed call ordering and nullish paths: %s", async (_name, body, count) => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: { "server/api/account.ts": `export default defineEventHandler(() => { ${body} })` },
  });
  expect(result.diagnostics.filter((item) => item.code === "NITRO0018")).toHaveLength(count);
});

test("enclosing async handler adopts rejected return", async () => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: {
      "server/api/account.ts":
        "export default defineEventHandler(async () => { try { throw createError({ statusCode: 404 }) } catch { return Promise.reject(new Error()) } })",
    },
  });
  expect(result.diagnostics.filter((item) => item.code === "NITRO0018")).toHaveLength(1);
});

test("enclosing synchronous handler adopts rejected return", async () => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: {
      "server/api/account.ts":
        "export default defineEventHandler(() => { try { throw createError({ statusCode: 404 }) } catch { return Promise.reject(new Error()) } })",
    },
  });
  expect(result.diagnostics.filter((item) => item.code === "NITRO0018")).toHaveLength(1);
});

test.each([
  [
    "function missing() { throw createError({ statusCode: 404 }) }; try { missing!() } catch { throw new Error() }",
    1,
  ],
  [
    "try { throw createError({ statusCode: 404 }) } catch (error) { const preserve = () => {}; if (preserve) throw error; throw new Error() }",
    0,
  ],
  [
    "try { throw createError({ statusCode: 404 }) } catch (error) { const preserve = {}; if (preserve) throw error; throw new Error() }",
    0,
  ],
  [
    "async function invalid() {}; try { new invalid(); throw createError({ statusCode: 404 }) } catch { throw new Error() }",
    0,
  ],
  [
    "function* invalid() {}; try { new invalid(); throw createError({ statusCode: 404 }) } catch { throw new Error() }",
    0,
  ],
])("respects known functions and TypeScript wrappers: %s", async (body, count) => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: { "server/api/account.ts": `export default defineEventHandler(() => { ${body} })` },
  });
  expect(result.diagnostics.filter((item) => item.code === "NITRO0018")).toHaveLength(count);
});

test.each([
  [
    "function defineEventHandler(callback) { return callback }; export default defineEventHandler(() => { try { throw createError({ statusCode: 404 }) } catch { return Promise.reject(new Error()) } })",
    0,
  ],
  [
    "import { eventHandler as handler } from 'h3'; export default handler(() => { try { throw createError({ statusCode: 404 }) } catch { return Promise.reject(new Error()) } })",
    1,
  ],
  [
    "import { eventHandler as handler } from 'other'; export default handler(() => { try { throw createError({ statusCode: 404 }) } catch { return Promise.reject(new Error()) } })",
    0,
  ],
])("adopts only H3 handler returns: %s", async (source, count) => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: { "server/api/account.ts": source },
  });
  expect(result.diagnostics.filter((item) => item.code === "NITRO0018")).toHaveLength(count);
});

test.each([
  "await (true ? Promise.reject(createError({ statusCode: 404 })) : null)",
  "await (0, Promise.reject(createError({ statusCode: 404 })))",
  "await (false || Promise.reject(createError({ statusCode: 404 })))",
  "await (true && Promise.reject(createError({ statusCode: 404 })))",
  "await (null ?? Promise.reject(createError({ statusCode: 404 })))",
  "await (unknownValue ?? Promise.reject(createError({ statusCode: 404 })))",
])("adopts the result of a composite await: %s", async (expression) => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: {
      "server/api/account.ts": `export default defineEventHandler(async () => { try { ${expression} } catch { throw new Error() } })`,
    },
  });
  expect(result.diagnostics.filter((item) => item.code === "NITRO0018")).toHaveLength(1);
});

test.each([
  ["for (const code of [404]) throw createError({ statusCode: code })", 1],
  ["for (const code of [500]) throw createError({ statusCode: code })", 0],
  ["for (const code of []) throw createError({ statusCode: code })", 0],
  [
    "for (const code of [500, 404]) { if (code === 500) { Array.prototype[Symbol.iterator] = function* () { yield 500 }; continue }; throw createError({ statusCode: code }) }",
    1,
  ],
  [
    "for (const code of [404, 500]) { if (code === 404) { Array.prototype[Symbol.iterator] = function* () { yield 404 }; continue }; throw createError({ statusCode: code }) }",
    0,
  ],
  [
    "Array.prototype[Symbol.iterator] = function* () {}; for (const code of [404]) throw createError({ statusCode: code })",
    0,
  ],
])("binds literal values inside protected for-of loops: %s", async (statement, count) => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: {
      "server/api/account.ts": `export default defineEventHandler(() => { try { ${statement} } catch { throw new Error() } })`,
    },
  });
  expect(result.diagnostics.filter((item) => item.code === "NITRO0018")).toHaveLength(count);
});

test.each([
  [
    "const options = { statusCode: 404 }; try { throw createError(options) } catch { throw new Error() }",
    1,
  ],
  [
    "const options = { statusCode: 404 }; const alias = options; try { throw createError(alias) } catch { throw new Error() }",
    1,
  ],
  [
    "try { throw createError({ statusCode: 404 }) } catch (error) { if (error instanceof Error) throw error; throw new Error() }",
    0,
  ],
  [
    "try { throw createError({ statusCode: 404, constructor: { __h3_error__: true } }) } catch (error) { if (error instanceof Error) throw error; throw new Error() }",
    1,
  ],
  [
    "const options = { statusCode: 404, constructor: { __h3_error__: true } }; try { throw createError(options) } catch (error) { if (error instanceof Error) throw error; throw new Error() }",
    1,
  ],
  [
    "try { throw createError({ statusCode: 404 }) } catch (error) { function Error() {}; if (error instanceof Error) throw error; throw createError({ statusCode: 500 }) }",
    1,
  ],
  [
    "Array.prototype[Symbol.iterator] = function* () {}; for (const code of [404]) { try { throw createError({ statusCode: code }) } catch { throw new Error() } }",
    0,
  ],
])("preserves known HTTP errors through local options and guards: %s", async (statement, count) => {
  const result = await runRuleFixture({
    framework: "nitro",
    rule: noHttpErrorMasking,
    files: {
      "server/api/account.ts": `export default defineEventHandler(() => { ${statement} })`,
    },
  });
  expect(result.diagnostics.filter((item) => item.code === "NITRO0018")).toHaveLength(count);
});
