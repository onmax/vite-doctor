import { expect, test } from "vite-plus/test";
import { createSarifReport } from "../../src/core/index.ts";
import { runRuleFixture } from "../../src/core/testkit.ts";
import { noClientSecretPattern } from "../../src/rule-packs/vite/rules/env.ts";

test.each([
  { name: "ASCII", prefix: 'const label = "hello"; ' },
  { name: "astral Unicode", prefix: 'const label = "😀🩺"; ' },
  { name: "combining Unicode and a tab", prefix: 'const label = "e\u0301";\t' },
  { name: "CRLF", prefix: 'const first = 1;\r\nconst label = "🩺"; ' },
])("SARIF declares the source column unit for $name", async ({ prefix }) => {
  const expression = "import.meta.env.VITE_SECRET_TOKEN";
  const source = `${prefix}${expression};\n`;
  const result = await runRuleFixture({
    rule: noClientSecretPattern,
    framework: "vite",
    files: { "src/main.ts": source },
  });
  expect(result.diagnostics).toHaveLength(1);
  const diagnostic = result.diagnostics[0]!;
  diagnostic.related = [
    { file: diagnostic.file, range: diagnostic.range, message: "Same source reference" },
  ];
  const run = JSON.parse(createSarifReport(result)).runs[0];
  expect(run.columnKind).toBe("utf16CodeUnits");
  const finding = run.results[0];
  for (const location of [...finding.locations, ...finding.relatedLocations]) {
    const region = location.physicalLocation.region;
    const line = source.split(/\r?\n/)[region.startLine - 1]!;
    expect(line.slice(region.startColumn - 1)).toBe(`${expression};`);
  }
});
