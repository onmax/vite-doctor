import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { allDiagnostics } from "../../src/core/index.ts";
import { runProjectFixture } from "../../src/core/testkit.ts";
import { createRule } from "../../src/extension.ts";

const ruleId = "test/unlocated-config";

// Reports at nuxt.config.ts without a source range.
const unlocatedConfigRule = createRule({
  meta: {
    id: ruleId,
    title: "Review the Nuxt config",
    category: "configuration",
    severity: "warn",
    execution: "manifest",
  },
  create(ctx) {
    return {
      onProjectStart() {
        ctx.report(
          allDiagnostics.DOC9999({ why: "Config needs review.", fix: "Review the config." }),
          {
            ruleId,
            severity: "warn",
            category: "configuration",
            file: join(ctx.project.root, "nuxt.config.ts"),
          },
        );
      },
    };
  },
});

test.each(["*", ruleId])(
  "an inline suppression for %s cannot hide a manifest diagnostic without a source range",
  async (selector) => {
    const result = await runProjectFixture({
      framework: "nuxt",
      rules: [unlocatedConfigRule],
      files: {
        "nuxt.config.ts": `export default defineNuxtConfig({})\n${"\n".repeat(12)}// doctor-disable ${selector} -- ignore a local diagnostic\n`,
      },
    });
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["DOC9999"]);
    expect(result.diagnostics[0]?.range).toBeUndefined();
    expect(result.suppressedDiagnostics).toEqual([]);
  },
);

test("configured suppression still applies to a manifest diagnostic without a source range", async () => {
  const result = await runProjectFixture({
    framework: "nuxt",
    rules: [unlocatedConfigRule],
    files: { "nuxt.config.ts": "export default defineNuxtConfig({})\n" },
    config: {
      suppressions: [
        { ruleId, file: "nuxt.config.ts", reason: "The deployment supplies the handler." },
      ],
    },
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.suppressedDiagnostics).toMatchObject([
    { code: "DOC9999", suppressionReason: "The deployment supplies the handler." },
  ]);
});

test("baseline suppression still applies to a manifest diagnostic without a source range", async () => {
  const files = { "nuxt.config.ts": "export default defineNuxtConfig({})\n" };
  const initial = await runProjectFixture({
    framework: "nuxt",
    rules: [unlocatedConfigRule],
    files,
  });
  expect(initial.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["DOC9999"]);
  const result = await runProjectFixture({
    framework: "nuxt",
    rules: [unlocatedConfigRule],
    files: {
      ...files,
      "baseline.json": JSON.stringify({
        diagnostics: [{ fingerprint: initial.diagnostics[0]!.fingerprint }],
      }),
    },
    run: { baseline: "baseline.json", newOnly: true },
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.suppressedDiagnostics).toMatchObject([
    { code: "DOC9999", suppressionReason: "baseline" },
  ]);
});
