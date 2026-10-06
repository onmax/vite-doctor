import { expect, test } from "vite-plus/test";
import { runProjectFixture, runRuleFixture } from "../../src/testkit.ts";
import vitehubExtension, { noLegacyKvImport } from "../fixtures/extension-library/doctor.ts";

const legacy = 'import { kv } from "@vite-hub/kv/legacy";\nexport const store = kv;\n';

test("runRuleFixture reports a single Rule's Diagnostics", async () => {
  const result = await runRuleFixture({
    rule: noLegacyKvImport,
    framework: "vite",
    files: { "src/store.ts": legacy, "src/ok.ts": 'import { kv } from "@vite-hub/kv";\n' },
  });
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      code: "VHUB0001",
      ruleId: "vitehub/no-legacy-kv-import",
      severity: "warn",
      category: "correctness",
      range: expect.objectContaining({ line: 1, column: 1 }),
    }),
  ]);
  expect(result.diagnostics[0]!.file.endsWith("src/store.ts")).toBe(true);
});

test("runProjectFixture runs a published Doctor Extension", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    extensions: [vitehubExtension],
    files: { "src/store.ts": legacy },
  });
  expect(result.diagnostics.map((item) => item.docs)).toEqual([
    "https://vitehub.example/doctor/VHUB0001",
  ]);
});
