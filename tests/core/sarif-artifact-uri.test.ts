import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vite-plus/test";
import { allDiagnostics, createSarifReport } from "../../src/core/index.ts";
import { createResult, normalizeDiagnostic } from "../../src/core/internal/diagnostics.ts";

const root = resolve(tmpdir(), "doctor-report-uri");

function resultFor(file: string) {
  const finding = normalizeDiagnostic({
    diagnostic: allDiagnostics.DOC9999({
      why: "A finding in a path containing URI syntax.",
      fix: "Review the source.",
    }),
    ruleId: "test/uri",
    severity: "warn",
    category: "test",
    file,
    related: [{ file, message: "The same file as related evidence." }],
  });
  return createResult(
    { root, framework: "vite", ssr: false, vueVersion: "3.5.0", isMonorepo: false },
    root,
    [finding],
    [],
    {},
  );
}

test.each([
  ["src/app.ts", "src/app.ts"],
  ["src/with spaces.ts", "src/with%20spaces.ts"],
  ["src/issue#42.ts", "src/issue%2342.ts"],
  ["src/100%25.ts", "src/100%2525.ts"],
  ["src/café-组件.ts", "src/caf%C3%A9-%E7%BB%84%E4%BB%B6.ts"],
  ["src/[id].ts", "src/%5Bid%5D.ts"],
  ["../shared/issue#42.ts", "../shared/issue%2342.ts"],
])("SARIF locations resolve to the literal file %s", (file, expectedUri) => {
  const absolute = resolve(root, file);
  const result = resultFor(absolute);
  const report = JSON.parse(createSarifReport(result));
  const diagnostic = report.runs[0].results[0];
  const uris = [
    diagnostic.locations[0].physicalLocation.artifactLocation.uri,
    diagnostic.relatedLocations[0].physicalLocation.artifactLocation.uri,
  ];
  const base = pathToFileURL(`${root}/`);
  for (const uri of uris) {
    expect(uri).toBe(expectedUri);
    const target = new URL(uri, base);
    expect(target.hash).toBe("");
    expect(target.search).toBe("");
    expect(fileURLToPath(target)).toBe(absolute);
  }
});

test.skipIf(process.platform === "win32")(
  "SARIF percent-encodes query and scheme syntax in POSIX filenames",
  () => {
    const result = resultFor(resolve(root, "scheme:file?.ts"));
    const report = JSON.parse(createSarifReport(result));
    const uri = report.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri;
    expect(uri).toBe("scheme%3Afile%3F.ts");
    expect(fileURLToPath(new URL(uri, pathToFileURL(`${root}/`)))).toBe(
      result.diagnostics[0]!.file,
    );
  },
);
