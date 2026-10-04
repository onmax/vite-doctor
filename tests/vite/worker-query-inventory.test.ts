import { describe, expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../src/core/testkit.ts";
import { noNodeApiInWorker } from "../../src/rules.ts";

describe("Vite worker query inventory", () => {
  test.each([
    "worker",
    "sharedworker",
    "worker&inline",
    "sharedworker&inline",
    "inline&worker",
    "inline&sharedworker",
  ])("finds Node imports in an entry selected by ?%s", async (query) => {
    const result = await runRuleFixture({
      rule: noNodeApiInWorker,
      framework: "vite",
      files: {
        "src/main.ts": `import Task from './task.ts?${query}'; console.log(Task)`,
        "src/task.ts": "import fs from 'node:fs'; console.log(fs)",
      },
    });

    expect(result.diagnostics.map(({ code }) => code)).toEqual(["VITE0020"]);
    expect(result.diagnostics[0]?.file).toMatch(/\/src\/task\.ts$/);
  });

  test.each(["raw", "sharedworker-helper", "type=sharedworker", "worker=false"])(
    "does not classify unrelated ?%s imports as worker entries",
    async (query) => {
      const result = await runRuleFixture({
        rule: noNodeApiInWorker,
        framework: "vite",
        files: {
          "src/main.ts": `import text from './task.ts?${query}'; console.log(text)`,
          "src/task.ts": "import fs from 'node:fs'; console.log(fs)",
        },
      });
      expect(result.diagnostics).toEqual([]);
    },
  );
});
