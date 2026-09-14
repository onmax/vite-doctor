import { expect, test } from "vite-plus/test";
import { noInlineStyles, shadcnRulePack } from "../../../src/rule-packs/shadcn/index.ts";
import { runProjectFixture } from "../../../src/core/testkit.ts";

test("activates for Tailwind projects and adapts upstream diagnostics", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    dependencies: { tailwindcss: "^4.0.0" },
    rules: [noInlineStyles],
    files: {
      "src/Button.tsx": "export function Button() { return <button style={{color: 'red'}} /> }",
    },
  });
  expect(result.diagnostics).toEqual([
    expect.objectContaining({ code: "SHAD0004", ruleId: "shadcn/no-inline-styles" }),
  ]);
});

test("uses Tailwind package activation and composed presets", () => {
  expect(shadcnRulePack.activation).toEqual({ packages: ["tailwindcss"] });
  expect(shadcnRulePack.presets.recommended).toEqual([
    "shadcn/no-raw-colors",
    "shadcn/no-arbitrary-values",
    "shadcn/no-inline-styles",
  ]);
});
