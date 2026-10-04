import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { preferValidatedRouterParams } from "../../../src/rule-packs/nitro/rules/prefer-validated-router-params.ts";

for (const framework of ["nitro", "nuxt"] as const) {
  const file = "server/api/users/[id].ts";
  const config: Record<string, string> =
    framework === "nitro" ? { "nitro.config.ts": "export default { srcDir: 'server' }" } : {};
  test.each([
    "schema.parse(id)",
    "schema.safeParse(id)",
    "schema.validate(id)",
    "validateId(id)",
    "assertId(id)",
  ])(`${framework} preserves scalar param validation: %s`, async (validation) => {
    const result = await runRuleFixture({
      rule: preferValidatedRouterParams,
      framework,
      files: {
        ...config,
        [file]: `export default defineEventHandler(event => { const id = getRouterParam(event, 'id'); return ${validation} })`,
      },
    });
    expect(result.diagnostics).toEqual([]);
  });

  test(`${framework} preserves decoded scalar param validation`, async () => {
    const result = await runRuleFixture({
      rule: preferValidatedRouterParams,
      framework,
      files: {
        ...config,
        [file]:
          "export default defineEventHandler(event => { const id = getRouterParam(event, 'id', { decode: true }); return schema.parse(id) })",
      },
    });
    expect(result.diagnostics).toEqual([]);
  });

  test.each(["schema.parse(params)", "schema.safeParse(params)", "validateParams(params)"])(
    `${framework} still recommends validating the params object: %s`,
    async (validation) => {
      const result = await runRuleFixture({
        rule: preferValidatedRouterParams,
        framework,
        files: {
          ...config,
          [file]: `export default defineEventHandler(event => { const params = getRouterParams(event); return ${validation} })`,
        },
      });
      expect(result.diagnostics.map((d) => d.ruleId)).toEqual([
        preferValidatedRouterParams.meta.id,
      ]);
      expect(result.diagnostics[0]?.suggestion).toContain(
        "getValidatedRouterParams(event, validator)",
      );
    },
  );

  test(`${framework} accepts an already validated params object`, async () => {
    const result = await runRuleFixture({
      rule: preferValidatedRouterParams,
      framework,
      files: {
        ...config,
        [file]:
          "export default defineEventHandler(event => getValidatedRouterParams(event, schema.parse))",
      },
    });
    expect(result.diagnostics).toEqual([]);
  });
}
