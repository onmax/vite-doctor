import { expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.js";
import { requireSafetyCommentForTypeAssertion } from "../../../src/rule-packs/typescript/index.js";

const cases: [string, string, number][] = [
  ["empty multiline block", "/* SAFETY:\n *\n */ const value = input as User", 1],
  [
    "multiline explanation",
    "/* SAFETY:\n * Schema validated this value.\n */ const value = input as User",
    0,
  ],
  ["missing", "const value = input as User", 1],
  ["empty marker", "// SAFETY:\nconst value = input as User", 1],
  ["empty block marker", "/* SAFETY: */ const value = input as User", 1],
  ["string marker", 'const message = "SAFETY: validated"; const value = input as User', 1],
  ["template marker", "const message = `SAFETY: validated`; const value = input as User", 1],
  ["unrelated statement", "// SAFETY: validated\nconst other = 1; const value = input as User", 1],
  ["trailing marker", "const value = input as User // SAFETY: validated", 1],
  ["identifier prefix", "// UNSAFETY: validated\nconst value = input as User", 1],
  [
    "multiline declaration",
    "// SAFETY: schema validated this input.\nconst value = (\n  input\n    as User\n)",
    0,
  ],
  ["inline assertion", "const value = /* SAFETY: schema validated this input. */ input as User", 0],
  [
    "export owner",
    "// SAFETY: schema validated this input.\nexport const value = input as User",
    0,
  ],
  [
    "return owner",
    "function get() {\n// SAFETY: schema validated this input.\nreturn input as User\n}",
    0,
  ],
  [
    "later statement",
    "// SAFETY: schema validated this input.\nconst first = input as User; const second = input as User",
    1,
  ],
  ["const assertion", "const value = { id: 1 } as const", 0],
  [
    "comment group",
    "// SAFETY: schema validated this input.\n// Preserve the brand.\nconst value = input as User",
    0,
  ],
  ["CRLF", "// SAFETY: schema validated this input.\r\nconst value = input as User", 0],
];

test.each(cases)("checks %s", async (_name, source, expected) => {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [requireSafetyCommentForTypeAssertion],
    files: { "index.ts": source },
  });
  expect(result.diagnostics).toHaveLength(expected);
});

test("uses script comments at original Vue file offsets", async () => {
  const result = await runProjectFixture({
    rules: [requireSafetyCommentForTypeAssertion],
    files: {
      "App.vue":
        '<template><p>SAFETY: validated</p></template>\n<script setup lang="ts">\nconst bad = input as User\n// SAFETY: schema validated this input.\nconst good = input as User\n</script>',
    },
  });
  expect(result.diagnostics.map((item) => item.code)).toEqual(["TS0008"]);
});
