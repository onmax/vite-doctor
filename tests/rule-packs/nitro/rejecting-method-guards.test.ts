import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { preferAssertMethod } from "../../../src/rule-packs/nitro/rules/prefer-assert-method.ts";

async function diagnose(body: string, file = "server/middleware/handler.ts") {
  return runRuleFixture({
    rule: preferAssertMethod,
    framework: "nitro",
    files: { [file]: `export default defineEventHandler(event => { ${body} })` },
  });
}

test.each([
  'if (getMethod(event) === "GET") return "read"; return "write"',
  'if (event.method !== "GET") return "write"; return "read"',
  'if (event.method === "GET") return "read"; else if (event.method === "POST") return "write"; else throw new Error("unsupported")',
  'const isPost = event.method === "POST"; return isPost',
  'return event.method === "GET" ? "read" : "write"',
  'if (event.method !== "POST") console.log("another method"); return "ok"',
  'if (event.method !== "GET" && event.method !== "POST") throw new Error("unsupported")',
  'if (event.method !== "POST") { if (allowOther) return "allowed"; throw new Error("unsupported") }',
  'if (event.method !== "POST") { if (reject) throw new Error("unsupported") }',
  'if (event.method !== "POST") { function reject() { throw new Error("unsupported") } }',
  'if (event.method !== "POST") { return "allowed"; throw new Error("unreachable") }',
  'if (event.method === "GET") { if (event.method !== "POST") throw new Error("unsupported") } return "ok"',
  'if (reject) { if (event.method !== "POST") throw new Error("unsupported") } return "ok"',
  'if (allowOther) return "allowed"; if (event.method !== "POST") throw new Error("unsupported")',
  'if (allowOther) return "allowed"; else if (event.method !== "POST") throw new Error("unsupported")',
  'while (reject) { if (event.method !== "POST") throw new Error("unsupported"); break } return "ok"',
  'try { if (event.method !== "POST") throw new Error("unsupported") } catch {} return "ok"',
  'function getMethod() { return "GET" } if (getMethod(event) !== "POST") throw createError({ statusCode: 405 })',
  '{ const getMethod = () => "GET"; if (getMethod(event) !== "POST") throw createError({ statusCode: 405 }) }',
])("does not turn method-dependent behavior into a rejecting assertion: %s", async (body) => {
  expect((await diagnose(body)).diagnostics).toEqual([]);
});

test.each([
  'if (getMethod(event) !== "POST") throw createError({ statusCode: 405 })',
  'if (event.method != "POST") { throw createError({ statusCode: 405 }) }',
  'if ("POST" !== event.method) { console.log("rejected"); throw createError({ statusCode: 405 }) }',
  'const method = getMethod(event); if (method !== "POST") throw createError({ statusCode: 405 })',
  'function audit() {} if (event.method !== "POST") throw createError({ statusCode: 405 })',
  'if (event.method !== "POST") { function audit() {} throw createError({ statusCode: 405 }) }',
  '{ if (event.method !== "POST") throw createError({ statusCode: 405 }) }',
])("retains advice for a rejecting single-method guard: %s", async (body) => {
  const result = await diagnose(body);
  expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
    preferAssertMethod.meta.id,
  ]);
  expect(result.diagnostics[0]?.suggestion).toContain('assertMethod(event, "POST")');
});

test("file-routed handlers still use route method suffix advice", async () => {
  const result = await diagnose(
    'if (getMethod(event) !== "POST") throw createError({ statusCode: 405 })',
    "server/api/item.ts",
  );
  expect(result.diagnostics).toEqual([]);
});

test.each(["middleware/handler.ts", "server/middleware/handler.ts"])(
  "retains rejecting guard advice in standalone middleware: %s",
  async (file) => {
    const result = await diagnose(
      'if (event.method !== "POST") throw createError({ statusCode: 405 })',
      file,
    );
    expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
      preferAssertMethod.meta.id,
    ]);
  },
);

test.each(["server/utils/handler.ts", "app/server/middleware/handler.ts"])(
  "keeps non-middleware standalone files outside method assertion advice: %s",
  async (file) => {
    const result = await diagnose(
      'if (event.method !== "POST") throw createError({ statusCode: 405 })',
      file,
    );
    expect(result.diagnostics).toEqual([]);
  },
);

test.each([
  ['import { getMethod } from "h3";', true],
  ['import { getMethod as getMethod } from "h3";', true],
  ['import { getMethod } from "./method";', false],
  ['import { other as getMethod } from "h3";', false],
  ['import getMethod from "h3";', false],
  ['import * as getMethod from "h3";', false],
  ['function getMethod() { return "GET" }', false],
])("resolves the imported or outer getMethod binding: %s", async (prefix, expected) => {
  const result = await runRuleFixture({
    rule: preferAssertMethod,
    framework: "nitro",
    files: {
      "server/middleware/handler.ts": `${prefix} export default defineEventHandler(event => {
        if (getMethod(event) !== "POST") throw createError({ statusCode: 405 })
      })`,
    },
  });
  expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual(
    expected ? [preferAssertMethod.meta.id] : [],
  );
});

test("retains H3 import advice for a top-level rejecting guard", async () => {
  const result = await runRuleFixture({
    rule: preferAssertMethod,
    framework: "nitro",
    files: {
      "server/middleware/handler.ts":
        'import { getMethod } from "h3"; if (getMethod(event) !== "POST") throw createError({ statusCode: 405 })',
    },
  });
  expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
    preferAssertMethod.meta.id,
  ]);
});

test("keeps a handler parameter shadowing the H3 import exempt", async () => {
  const result = await runRuleFixture({
    rule: preferAssertMethod,
    framework: "nitro",
    files: {
      "server/middleware/handler.ts":
        'import { getMethod } from "h3"; export default defineEventHandler((event, getMethod) => { if (getMethod(event) !== "POST") throw createError({ statusCode: 405 }) })',
    },
  });
  expect(result.diagnostics).toEqual([]);
});
