import { expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../src/core/testkit.ts";
import { noNodeApiInWorker } from "../../src/rule-packs/vite/rules/worker.ts";

test("does not report a worker's local process binding as a Node API", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noNodeApiInWorker],
    files: {
      "src/main.ts": `new Worker(new URL("./worker.ts", import.meta.url))
new Worker(new URL("./global-worker.ts", import.meta.url))`,
      "src/worker.ts": `const process = { complete: true }
console.log(process.complete)`,
      "src/global-worker.ts": `console.log(process.env.NODE_ENV)`,
    },
  });

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.file).toMatch(/global-worker\.ts$/);
});
