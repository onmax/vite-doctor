import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vite-plus/test";
import { runViteDoctor } from "../../src/doctor.ts";
import { detectProject, evaluatePackActivation } from "../../src/core/index.ts";
import { typescriptRulePack } from "../../src/rule-packs/typescript/index.ts";

test.each([
  '<script setup generic="T extends Record<string, unknown>" lang="ts">',
  '<script setup data-example="x > y" lang="ts">',
])("activates TypeScript from the actual %s block", async (opening) => {
  await withProject(`${opening}\nconst user = input as object as User\n</script>`, async (root) => {
    const result = await runViteDoctor({
      root,
      framework: "vue",
      runtimeTarget: { vue: "3.5.0" },
      cache: false,
    });
    expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toContain(
      "typescript/evidence/no-chained-type-assertions",
    );
    expect(result.project.languages).toEqual(["typescript"]);
  });
});

test.each([
  {
    source: '<!-- <script lang="ts"> -->\n<template><p>Example</p></template>',
    languages: [],
  },
  {
    source: "<script setup>const example = '<script lang=\"ts\">';</script>",
    languages: ["javascript"],
  },
  {
    source:
      '<docs><script lang="ts">const example: string = "docs"</script></docs><template><p>Example</p></template>',
    languages: [],
  },
  {
    source: '<template><div>{{</template><docs><script lang="ts"></script></docs>',
    languages: [],
  },
  {
    source: '<template><div>{{</template><script>const text = "<script lang=\\"ts\\">"</script>',
    languages: ["javascript"],
  },
])("ignores script-like text in $source", async ({ source, languages }) => {
  await withProject(source, async (root) => {
    const project = await detectProject(root, "vite");
    expect(project.languages).toEqual(languages);
    expect(evaluatePackActivation(typescriptRulePack, project).state).toBe("inactive");
  });
});

test("recovers script language evidence from a partially malformed SFC", async () => {
  await withProject(
    '<template><div>{{</template>\n<script setup lang="ts">const value: string = "ok"</script>',
    async (root) => {
      expect((await detectProject(root, "vite")).languages).toEqual(["typescript"]);
    },
  );
});

test.each([
  {
    source: '<script setup lang="tsx">const render = () => <p />;</script>',
    language: "typescript",
  },
  { source: '<script lang=ts>export const value: string = "ok";</script>', language: "typescript" },
  {
    source: '<script setup lang="jsx">const render = () => <p />;</script>',
    language: "javascript",
  },
  { source: "<script>export default {};</script>", language: "javascript" },
])("preserves language evidence for $source", async ({ source, language }) => {
  await withProject(source, async (root) => {
    expect((await detectProject(root, "vite")).languages).toEqual([language]);
  });
});

async function withProject(source: string, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "doctor-vue-languages-"));
  try {
    for (const [name, content] of Object.entries({ "package.json": "{}", "app.vue": source })) {
      const path = join(root, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
