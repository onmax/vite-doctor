import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import {
  requireImageAlt,
  preferResponsiveDimensions,
  preferNuxtPictureForFormats,
} from "../../../src/rule-packs/nuxt/rules/nuxt-image.ts";

for (const tag of [
  "NuxtImg",
  "nuxt-img",
  "nuxtImg",
  "Nuxt-Img",
  "nuxt-Img",
  "NuxtPicture",
  "nuxt-picture",
  "nuxtPicture",
  "Nuxt-Picture",
  "nuxt-Picture",
  "img",
]) {
  test.each([
    ["", 1],
    ['alt=""', 0],
    [':alt="description"', 0],
  ] as const)(`${tag} alt ownership: %s`, async (attributes, expected) => {
    const result = await runRuleFixture({
      rule: requireImageAlt,
      framework: "nuxt",
      files: { "app/app.vue": `<template><${tag} src="/image.png" ${attributes} /></template>` },
    });
    expect(result.diagnostics).toHaveLength(expected);
  });
}

for (const tag of [
  "NuxtImg",
  "nuxt-img",
  "nuxtImg",
  "Nuxt-Img",
  "nuxt-Img",
  "NuxtPicture",
  "nuxt-picture",
  "nuxtPicture",
  "Nuxt-Picture",
  "nuxt-Picture",
]) {
  test.each([
    ':width="width"',
    ':height="height"',
    'v-bind:width="width"',
    'v-bind:height="height"',
    'width="100"',
    ':sizes="sizes"',
  ])(`${tag} accepts supplied dimensions: %s`, async (attributes) => {
    const result = await runRuleFixture({
      rule: preferResponsiveDimensions,
      framework: "nuxt",
      files: { "app/app.vue": `<template><${tag} src="/image.png" ${attributes} /></template>` },
    });
    expect(result.diagnostics).toEqual([]);
  });
  test(`${tag} reports absent dimensions`, async () => {
    const result = await runRuleFixture({
      rule: preferResponsiveDimensions,
      framework: "nuxt",
      files: { "app/app.vue": `<template><${tag} src="/image.png" /></template>` },
    });
    expect(result.diagnostics.map((d) => d.ruleId)).toEqual([preferResponsiveDimensions.meta.id]);
  });
}

test.each(["NuxtImg", "nuxt-img", "nuxtImg", "Nuxt-Img", "nuxt-Img"])(
  "format advice recognizes %s",
  async (tag) => {
    const result = await runRuleFixture({
      rule: preferNuxtPictureForFormats,
      framework: "nuxt",
      files: { "app/app.vue": `<template><${tag} src="/image.png" format="avif" /></template>` },
    });
    expect(result.diagnostics.map((d) => d.ruleId)).toEqual([preferNuxtPictureForFormats.meta.id]);
  },
);

test.each(["Nuxt_Img", "nuxt--img"])("ignores unsupported component spelling %s", async (tag) => {
  const result = await runRuleFixture({
    rule: requireImageAlt,
    framework: "nuxt",
    files: { "app/app.vue": `<template><${tag} src="/image.png" /></template>` },
  });
  expect(result.diagnostics).toEqual([]);
});
