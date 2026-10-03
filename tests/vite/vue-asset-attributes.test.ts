import { compileTemplate } from "@vue/compiler-sfc";
import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../src/core/testkit.ts";
import { noSrcAbsolutePublicUrl } from "../../src/rules.ts";

const transformed = [
  '<img src="/src/assets/logo.svg" />',
  '<video src="/src/assets/movie.mp4" />',
  '<video poster="/src/assets/poster.png" />',
  '<source src="/src/assets/movie.mp4" />',
  '<svg><image href="/src/assets/logo.svg" /></svg>',
  '<svg><image xlink:href="/src/assets/logo.svg" /></svg>',
  '<svg><use href="/src/assets/icons.svg#logo" /></svg>',
  '<svg><use xlink:href="/src/assets/icons.svg#logo" /></svg>',
  '<img srcset="/src/assets/small.png 1x, /src/assets/large.png 2x" />',
  '<source srcset="/src/assets/small.png 1x, /src/assets/large.png 2x" />',
];

const untransformed = [
  '<audio src="/src/assets/music.mp3" />',
  '<track src="/src/assets/captions.vtt" />',
  '<iframe src="/src/assets/frame.html" />',
  '<embed src="/src/assets/file.pdf" />',
  '<object data="/src/assets/file.pdf" />',
  '<input type="image" src="/src/assets/button.png" />',
  '<a href="/src/assets/file.pdf">Download</a>',
  `<img :src="'/src/assets/logo.svg'" />`,
  `<img v-bind:src="'/src/assets/logo.svg'" />`,
  '<img :src="`/src/assets/logo.svg`" />',
];

async function diagnose(template: string) {
  return runRuleFixture({
    rule: noSrcAbsolutePublicUrl,
    framework: "vite",
    files: { "src/App.vue": `<template>${template}</template>` },
  });
}

test.each(transformed)("allows a source URL transformed by Vue: %s", async (source) => {
  const compiled = compileTemplate({
    source,
    filename: "src/App.vue",
    id: "asset-test",
    transformAssetUrls: { includeAbsolute: true },
  });
  expect(compiled.errors).toEqual([]);
  expect(compiled.code).toMatch(/import _imports_\d+ from ['"]\/src\/assets\//);
  expect((await diagnose(source)).diagnostics).toEqual([]);
});

test.each([
  '<div title="/src/assets/logo.svg" />',
  '<div data-src="/src/assets/logo.svg" />',
  '<img alt="/src/assets/logo.svg" />',
  '<Card label="/src/assets/logo.svg" />',
  '<AssetPreview src="/src/assets/logo.svg" />',
  '<constructor src="/src/assets/logo.svg" />',
  '<Img src="/src/assets/logo.svg" />',
  '<img src="/logo.svg" />',
  '<img :src="logoUrl" />',
  `<img :[attribute]="'/src/assets/logo.svg'" />`,
  `<div :title="'/src/assets/logo.svg'" />`,
])("ignores attributes without a known untransformed asset URL: %s", async (source) => {
  expect((await diagnose(source)).diagnostics).toEqual([]);
});

test.each(untransformed)("reports a source URL left in the compiled output: %s", async (source) => {
  const compiled = compileTemplate({
    source,
    filename: "src/App.vue",
    id: "asset-test",
    transformAssetUrls: { includeAbsolute: true },
  });
  expect(compiled.errors).toEqual([]);
  expect(compiled.code).not.toMatch(/import _imports_/);
  expect((await diagnose(source)).diagnostics.map(({ code }) => code)).toEqual(["VITE0003"]);
});
