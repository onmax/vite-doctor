import { writeFileSync } from "node:fs";
import { join, relative } from "pathe";
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
    expect(missing.project.inventory?.packageArtifacts).toMatchObject([
      { missing: ["dist/index.js"] },
    ]);
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

test("analyzes each publishable workspace package from the workspace root", async () => {
  await withPackage(
    { private: true, workspaces: ["packages/*"] },
    {
      "packages/lib/package.json": JSON.stringify({ name: "lib", ...manifest }),
      "packages/lib/dist/index.js": files["dist/index.js"],
      "packages/unbuilt/package.json": JSON.stringify({ name: "unbuilt", main: "dist/index.js" }),
      "packages/internal/package.json": JSON.stringify({
        name: "internal",
        private: true,
        main: "index.js",
      }),
      "packages/internal/index.js": 'import "phantom";',
    },
    async (root) => {
      const result = await runViteDoctor({
        root,
        framework: "vite",
        cache: false,
        extends: ["package/recommended"],
      });
      const diagnostics = result.diagnostics.filter((d) => d.ruleId.startsWith("package/"));
      expect(
        diagnostics
          .map((d) => `${d.code} ${relative(root, d.file)}`)
          .sort((a, b) => a.localeCompare(b)),
      ).toEqual(["PKG0001 packages/lib/dist/index.js", "PKG0003 packages/lib/dist/index.js"]);
      for (const diagnostic of diagnostics)
        expect(diagnostic.evidence?.find((item) => item.kind === "manifest")?.file).toBe(
          join(root, "packages/lib/package.json"),
        );
      expect(JSON.parse(createJsonReport(result)).evidenceGaps).toEqual([
        expect.objectContaining({ files: ["packages/unbuilt/dist/index.js"] }),
      ]);
    },
  );
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
