import { beforeAll, bench } from "vite-plus/test";
import { createRule, type SourceFileHandle } from "../../src/core/primitives.ts";
import { runProjectFixture } from "../../src/core/testkit.ts";
import { runVisitor } from "../../src/core/internal/rule-runner.ts";

let file: SourceFileHandle;

beforeAll(async () => {
  const declarations = Array.from({ length: 200 }, (_, index) => `const value${index} = ${index}`);
  const elements = Array.from({ length: 200 }, (_, index) => `<span>{{ value${index} }}</span>`);
  await runProjectFixture({
    files: {
      "app.vue": `<script setup>\n${declarations.join("\n")}\n</script>
<template><div>${elements.join("\n")}</div></template>`,
    },
    rules: [
      createRule({
        meta: {
          id: "test/capture-file",
          title: "Capture benchmark file",
          category: "performance",
          severity: "info",
        },
        create(ctx) {
          file = ctx.file;
        },
      }),
    ],
  });
  if (!file.scriptAst || !file.templateAst || !file.sfc) {
    throw new Error("The benchmark requires parsed script, template, and SFC handles");
  }
});

bench("SFC visitor on a 200-binding component", async () => {
  await runVisitor({ SFC() {} }, file);
});

bench("script visitor on a 200-binding component", async () => {
  await runVisitor({ ScriptNode() {} }, file);
});

bench("template visitor on a 200-binding component", async () => {
  await runVisitor({ TemplateNode() {} }, file);
});
