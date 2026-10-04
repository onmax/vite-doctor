import { expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../src/core/testkit.ts";
import { noClientSecretPattern } from "../../src/rule-packs/vite/rules/env.ts";

test.each(["d.ts", "d.mts", "d.cts"])(
  "treats .%s declarations as a type surface",
  async (extension) => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [noClientSecretPattern],
      files: {
        "src/main.ts": "globalThis.doctorAmbient = 1; console.log(doctorAmbient);",
        [`src/host.${extension}`]:
          "export interface HostContract { name: string } declare global { var doctorAmbient: number; }",
      },
      run: { analyses: "dead-code" },
    });
    expect(
      result.diagnostics.filter((item) => item.ruleId.startsWith("workspace/dead-code/unused-")),
    ).toEqual([]);
  },
);

test.each(["mts", "cts"])("still reports unused .%s implementations", async (extension) => {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noClientSecretPattern],
    files: {
      "src/main.ts": "console.log(1);",
      [`src/unused.${extension}`]: "console.log(2);",
    },
    run: { analyses: "dead-code" },
  });
  expect(
    result.diagnostics.filter((item) => item.ruleId === "workspace/dead-code/unused-file"),
  ).toEqual([expect.objectContaining({ file: expect.stringContaining(`unused.${extension}`) })]);
});
