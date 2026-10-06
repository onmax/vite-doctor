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
