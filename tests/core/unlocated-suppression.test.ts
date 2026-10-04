import { expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../src/core/testkit.ts";
import { requireStandardAuthHandlerMount } from "../../src/rule-packs/nuxt/rules/nuxt-better-auth.ts";

const ruleId = requireStandardAuthHandlerMount.meta.id;

test.each(["*", ruleId])(
  "an inline suppression for %s cannot hide a manifest diagnostic without a source range",
  async (selector) => {
    const result = await runProjectFixture({
      framework: "nuxt",
      rules: [requireStandardAuthHandlerMount],
      files: {
        "nuxt.config.ts": `export default defineNuxtConfig({})\n${"\n".repeat(12)}// doctor-disable ${selector} -- ignore a local diagnostic\n`,
      },
    });
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["NUXT0003"]);
    expect(result.diagnostics[0]?.range).toBeUndefined();
    expect(result.suppressedDiagnostics).toEqual([]);
  },
);

test("configured suppression still applies to a manifest diagnostic without a source range", async () => {
  const result = await runProjectFixture({
    framework: "nuxt",
    rules: [requireStandardAuthHandlerMount],
    files: { "nuxt.config.ts": "export default defineNuxtConfig({})\n" },
    config: {
      suppressions: [
        { ruleId, file: "nuxt.config.ts", reason: "The deployment supplies the handler." },
      ],
    },
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.suppressedDiagnostics).toMatchObject([
    { code: "NUXT0003", suppressionReason: "The deployment supplies the handler." },
  ]);
});

test("baseline suppression still applies to a manifest diagnostic without a source range", async () => {
  const files = { "nuxt.config.ts": "export default defineNuxtConfig({})\n" };
  const initial = await runProjectFixture({
    framework: "nuxt",
    rules: [requireStandardAuthHandlerMount],
    files,
  });
  expect(initial.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["NUXT0003"]);
  const result = await runProjectFixture({
    framework: "nuxt",
    rules: [requireStandardAuthHandlerMount],
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
    { code: "NUXT0003", suppressionReason: "baseline" },
  ]);
});
