import { writeFileSync } from "node:fs";
import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { runViteDoctor } from "../../../src/doctor.js";
import {
  createAgentReport,
  createJsonReport,
  createTextReport,
  reportStatus,
} from "../../../src/core/reports.js";
import { packageRulePack } from "../../../src/rule-packs/package/index.js";
import {
  getDiagnosticDocuments,
  getRuleDocuments,
  rulesCollectionSource,
} from "../../../docs/rules/source.js";
import { withPackage } from "./fixture.js";

const manifest = {
  main: "dist/index.js",
  peerDependencies: { peer: "*" },
  peerDependenciesMeta: { peer: { optional: true } },
};
const files = { "dist/index.js": 'import "peer"; import "phantom";' };

test("is available in the distribution but only runs when explicitly selected", async () => {
  await withPackage(manifest, files, async (root) => {
    const automatic = await runViteDoctor({ root, framework: "vite", cache: false });
    expect(automatic.diagnostics.filter((d) => d.ruleId.startsWith("package/"))).toEqual([]);
    const selected = await runViteDoctor({
      root,
      framework: "vite",
      cache: false,
      extends: ["auto", "package/recommended"],
    });
    expect(selected.diagnostics.filter((d) => d.ruleId.startsWith("package/"))).toHaveLength(
      packageRulePack.rules.length,
    );
    const disabled = await runViteDoctor({
      root,
      framework: "vite",
      cache: false,
      config: {
        extends: ["package/recommended"],
        rules: Object.fromEntries(
          packageRulePack.rules.map((rule) => [rule.meta.id, "off" as const]),
        ),
      },
    });
    expect(disabled.diagnostics).toEqual([]);
  });
});

test("rereads artifacts on each Doctor Run and exposes missing output in inventory", async () => {
  await withPackage(manifest, {}, async (root) => {
    const options = { root, framework: "vite" as const, extends: ["package/recommended"] };
    const missing = await runViteDoctor(options);
    expect(reportStatus(missing)).toBe("incomplete");
    expect(JSON.parse(createJsonReport(missing)).evidenceGaps[0].files).toEqual(["dist/index.js"]);
    expect(createTextReport(missing)).toContain("Build the package");
    expect(JSON.parse(createAgentReport(missing)).commands.verify).toContain(
      "--extends package/recommended",
    );
    expect(missing.project.inventory?.packageArtifacts).toMatchObject({
      missing: ["dist/index.js"],
    });
    writeFileSync(join(root, "package.json"), JSON.stringify({ ...manifest, main: "index.js" }));
    writeFileSync(join(root, "index.js"), files["dist/index.js"]);
    const built = await runViteDoctor(options);
    expect(built.diagnostics.filter((d) => d.ruleId.startsWith("package/"))).toHaveLength(
      packageRulePack.rules.length,
    );
    writeFileSync(join(root, "index.js"), "export const ready = true;");
    const rebuilt = await runViteDoctor(options);
    expect(rebuilt.diagnostics.filter((d) => d.ruleId.startsWith("package/"))).toEqual([]);
  });
});

test("generates rule and diagnostic pages for every package diagnostic code", async () => {
  for (const rule of packageRulePack.rules) {
    const document = getRuleDocuments().find((entry) => entry.id === rule.meta.id)!;
    expect(document.framework).toBe("package");
    expect(await rulesCollectionSource.getItem(document.key)).toContain(
      "--extends package/recommended",
    );
    for (const code of rule.meta.diagnosticCodes!) {
      expect(getDiagnosticDocuments().find((entry) => entry.code === code)).toMatchObject({
        ruleId: rule.meta.id,
        path: `/diagnostics/${code}`,
        framework: "package",
      });
    }
  }
});
