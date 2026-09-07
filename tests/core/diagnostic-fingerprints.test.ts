import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { afterEach, expect, test } from "vite-plus/test";
import { runDoctor } from "../../src/core/index.ts";

const roots: string[] = [];
const ruleId = "workspace/dead-code/unresolved-import";

function fixture(source: string) {
  const root = mkdtempSync(join(tmpdir(), "doctor-fingerprints-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(root, "index.ts"), source);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.each([" ", "\n"])(
  "distinct unresolved imports have distinct fingerprints with separator %j",
  async (separator) => {
    const root = fixture(["import './missing-one';", "import './missing-two';"].join(separator));
    const result = await runDoctor({ root, analyses: "dead-code", cache: false });
    const diagnostics = result.diagnostics.filter((diagnostic) => diagnostic.ruleId === ruleId);
    expect(diagnostics.map((diagnostic) => diagnostic.why)).toEqual([
      'Import "./missing-one" could not be resolved.',
      'Import "./missing-two" could not be resolved.',
    ]);
    expect(new Set(diagnostics.map((diagnostic) => diagnostic.fingerprint)).size).toBe(2);
  },
);

test("a baseline for one missing import does not suppress a different missing import", async () => {
  const root = fixture("import './missing-one';");
  const options = { root, analyses: "dead-code", baseline: "baseline.json", cache: false };
  const first = await runDoctor({ ...options, updateBaseline: true });
  const original = first.diagnostics.find((diagnostic) => diagnostic.ruleId === ruleId)!;
  writeFileSync(join(root, "index.ts"), "import './missing-one'; import './missing-two';");
  const second = await runDoctor({ ...options, newOnly: true });
  expect(second.diagnostics.filter((diagnostic) => diagnostic.ruleId === ruleId)).toMatchObject([
    { why: 'Import "./missing-two" could not be resolved.' },
  ]);
  expect(
    second.suppressedDiagnostics?.filter((diagnostic) => diagnostic.ruleId === ruleId),
  ).toMatchObject([{ fingerprint: original.fingerprint, suppressionReason: "baseline" }]);
});

test("fingerprints survive repeated runs and insertion of unrelated lines", async () => {
  const root = fixture("import './missing-one';");
  const options = { root, analyses: "dead-code", cache: false };
  const fingerprints = async () =>
    (await runDoctor(options)).diagnostics
      .filter((diagnostic) => diagnostic.ruleId === ruleId)
      .map((diagnostic) => diagnostic.fingerprint);
  const original = await fingerprints();
  expect(original).toHaveLength(1);
  expect(original[0]).toMatch(/^[a-f0-9]{64}$/);
  expect(await fingerprints()).toEqual(original);
  writeFileSync(join(root, "index.ts"), "// unrelated heading\n\nimport './missing-one';");
  expect(await fingerprints()).toEqual(original);
});
