import { expect, test } from "vite-plus/test";
import type {
  TemplateDirectiveNode,
  TemplateElementNode,
  TemplateInterpolationNode,
} from "../../src/core/primitives.ts";
import { parseSfcFile } from "../../src/core/internal/sfc.ts";
import {
  parseTemplateExpression,
  templateDirectiveBindings,
  templateExpressionReferences,
  walkTemplate,
} from "../../src/core/internal/template.ts";

async function template(source: string) {
  const sfc = await parseSfcFile("/app.vue", source);
  const directives: TemplateDirectiveNode[] = [];
  const interpolations: TemplateInterpolationNode[] = [];
  walkTemplate(sfc.getTemplateAst()!, (node) => {
    if (node.type === 7) directives.push(node);
    if (node.type === 5) interpolations.push(node);
  });
  return { directives, interpolations };
}

test("parses template expressions at SFC offsets, TypeScript included", async () => {
  const source = `<template>\n  <img :src="  (url as string) " :alt="label">{{ count + 1 }}</template>`;
  const { directives, interpolations } = await template(source);

  const src = parseTemplateExpression(directives[0]!.exp!) as any;
  expect(src.type).toBe("TSAsExpression");
  expect(source.slice(src.start, src.end)).toBe("url as string");
  expect(source.slice(src.expression.start, src.expression.end)).toBe("url");
  expect(src.expression.__doctorParent).toBe(src);

  const sum = parseTemplateExpression(interpolations[0]!.content) as any;
  expect(source.slice(sum.start, sum.end)).toBe("count + 1");
  expect(parseTemplateExpression(interpolations[0]!.content)).toBe(sum);
});

test("returns null for values that are not one expression", async () => {
  const { directives } = await template(
    `<template><Comp v-for="(item, index) in items" v-slot="{ row }" @click="a(); b()" :[key]="value" /></template>`,
  );
  const [vFor, vSlot, vOn, bind] = directives;

  expect(parseTemplateExpression(vFor!.exp!)).toBeNull();
  expect(parseTemplateExpression(vFor!.forParseResult!.source)).toMatchObject({ name: "items" });
  expect(parseTemplateExpression(vSlot!.exp!)).toBeNull();
  expect(parseTemplateExpression(vOn!.exp!)).toBeNull();
  expect(parseTemplateExpression(bind!.arg!)).toMatchObject({ type: "Identifier", name: "key" });
  expect(parseTemplateExpression(bind!.exp!)).toMatchObject({ type: "Identifier", name: "value" });
});

test("collects free references and template bindings", async () => {
  const { directives } = await template(
    `<template><li v-for="({ id }, index) in rows" v-slot="{ row = fallback }" :title="list.map((item) => item[id] + offset).join(sep)" @click="count += 1; total = 2" /></template>`,
  );
  const [vFor, vSlot, title] = directives;

  expect(templateDirectiveBindings(vFor!)).toEqual(["id", "index"]);
  expect(templateDirectiveBindings(vSlot!)).toEqual(["row"]);
  expect(
    templateExpressionReferences(parseTemplateExpression(title!.exp!)!).map(
      (reference) => `${reference.id.name}:${reference.mode}`,
    ),
  ).toEqual(["list:r", "id:r", "offset:r", "sep:r"]);
});

test.each([
  ["{ const local = 1; local; } return local", ["local"]],
  ["{ let local = 1; local; } return local", ["local"]],
  ["{ class local {}; local; } return local", ["local"]],
  ["{ function local() {}; local; } return local", ["local"]],
  ["{ var local = 1; } return local", []],
  ["const local = 1; return local", []],
  ["function local() {}; return local", []],
  ["for (let local = 0; local < 1; local++) {} return local", ["local"]],
  ["switch (value) { case 1: const local = 1; local; } return local", ["value", "local"]],
])("preserves lexical scopes in %s", async (body, names) => {
  const { directives } = await template(
    `<template><div :value="(() => { ${body} })()" /></template>`,
  );
  const references = templateExpressionReferences(parseTemplateExpression(directives[0]!.exp!)!);
  expect(references.map(({ id }) => id.name)).toEqual(names);
});

test("does not expose non-HTML templates", async () => {
  const sfc = await parseSfcFile(
    "/app.vue",
    `<template lang="pug">\ndiv\n  button Save\n</template>`,
  );
  expect(sfc.getTemplateAst()).toBeNull();
  const html = await parseSfcFile("/app.vue", "<template><div /></template>");
  expect((html.getTemplateAst()!.children[0] as TemplateElementNode).tag).toBe("div");
});
