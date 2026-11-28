import { expect, test } from "vite-plus/test";
import { allDiagnostics, RESERVED_DIAGNOSTIC_CODE_PREFIXES } from "../../src/core/index.ts";
import { diagnosticCodePrefix } from "../../src/core/diagnostic-constants.ts";

test("reserved Diagnostic Code Prefixes are exactly the built-in prefixes", () => {
  const builtIn = new Set(Object.keys(allDiagnostics).map((code) => diagnosticCodePrefix(code)));
  const byName = (a?: string, b?: string) => String(a).localeCompare(String(b));
  expect([...builtIn].toSorted(byName)).toEqual(
    [...RESERVED_DIAGNOSTIC_CODE_PREFIXES].toSorted(byName),
  );
});

test.each([
  ["H30001", "H3"],
  ["NITRO0001", "NITRO"],
  ["TS0017", "TS"],
  ["DOC9999", "DOC"],
  ["ACME0001", "ACME"],
])("parses the Diagnostic Code Prefix of %s", (code, prefix) => {
  expect(diagnosticCodePrefix(code)).toBe(prefix);
});

test.each(["h30001", "3H0001", "H3", "H3-0001"])("rejects malformed code %s", (code) => {
  expect(diagnosticCodePrefix(code)).toBeUndefined();
});
