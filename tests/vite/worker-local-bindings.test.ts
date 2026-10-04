import * as parser from "@typescript-eslint/parser";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { runProjectFixture } from "../../src/core/testkit.ts";
import { noNodeApiInWorker } from "../../src/rule-packs/vite/rules/worker.ts";

afterEach(() => vi.restoreAllMocks());

test("does not report a worker's local process binding as a Node API", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noNodeApiInWorker],
    files: {
      "src/main.ts": `new Worker(new URL("./worker.ts", import.meta.url))
new Worker(new URL("./global-worker.ts", import.meta.url))`,
      "src/worker.ts": `const process = { complete: true }
console.log(process.complete)`,
      "src/global-worker.ts": `function complete(process: { done: boolean }) { return process.done }
console.log(process.env.NODE_ENV)`,
    },
  });

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.file).toMatch(/global-worker\.ts$/);
  expect(result.diagnostics[0]?.range?.line).toBe(2);
});

test.each([
  `import process from "./task.ts"; process()`,
  `export function run(process: () => void) { process() }`,
  `export const run = (process: () => void) => process()`,
  `export const run = ({ process }: { process: () => void }) => process()`,
  `function process() {}; process()`,
  `const task = { process: () => {} }; task.process()`,
  `const { process } = { process: () => {} }; process()`,
  `type Runtime = typeof process`,
])("accepts worker-local bindings and non-runtime identifiers: %s", async (source) => {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noNodeApiInWorker],
    files: { "src/task.worker.ts": source },
  });

  expect(result.diagnostics).toHaveLength(0);
});

test.each([
  `function complete(process: unknown) {}; console.log(process.env.NODE_ENV)`,
  `{ const process = {}; }; console.log(process.env.NODE_ENV)`,
  `const note = "const process = {}"; console.log(process.env.NODE_ENV)`,
  `const task = { process: true }; console.log(process.env.NODE_ENV)`,
  `console.log(process.env.NODE_ENV); function complete(process: unknown) {}`,
])("reports the global process reference outside local scopes: %s", async (source) => {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noNodeApiInWorker],
    files: { "src/task.worker.ts": source },
  });

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.range?.start).toBe(source.indexOf("process.env"));
});

test("keeps Node process imports diagnostic even when the binding is local", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noNodeApiInWorker],
    files: {
      "src/task.worker.ts": `import process from "node:process"; console.log(process.env.NODE_ENV)`,
    },
  });

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.why).toContain('imports Node module "node:process"');
});

test("reports global process in a TSX Vue worker", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noNodeApiInWorker],
    files: {
      "src/main.ts": `new Worker(new URL("./task.worker.vue", import.meta.url))`,
      "src/task.worker.vue": `<script setup lang="tsx">
const view = <span>{process.env.NODE_ENV}</span>
</script>`,
    },
  });

  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.why).toContain("should not rely on process");
});

test.each(["ts", "vue"])(
  "keeps worker diagnostics when lexical parsing fails: %s",
  async (extension) => {
    vi.spyOn(parser, "parseForESLint").mockImplementation(() => {
      throw new SyntaxError("Unsupported syntax");
    });
    const source = "await using resource = acquire(); console.log(process.env.NODE_ENV)";
    const text = extension === "vue" ? `<script setup lang="ts">${source}</script>` : source;
    const result = await runProjectFixture({
      framework: "vite",
      rules: [noNodeApiInWorker],
      files: {
        "src/main.ts": `new Worker(new URL("./task.worker.${extension}", import.meta.url))`,
        [`src/task.worker.${extension}`]: text,
      },
    });

    expect(result.diagnostics.map(({ code }) => code)).toEqual(["VITE0020"]);
    expect(result.diagnostics[0]?.range?.start).toBe(text.indexOf("process.env"));
  },
);
