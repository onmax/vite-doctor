import { createRequire } from "node:module";
import type TypeScript from "typescript";
import type * as VueCompilerSfc from "@vue/compiler-sfc";

// Loading these parsers costs more than a fully cached Doctor Run, so they load on first use.
const require = createRequire(import.meta.url);
let typescript: typeof TypeScript | undefined;
let vueCompilerSfc: typeof VueCompilerSfc | undefined;

export function loadTypeScript(): typeof TypeScript {
  return (typescript ??= require("typescript"));
}

export function loadVueCompilerSfc(): typeof VueCompilerSfc {
  return (vueCompilerSfc ??= require("@vue/compiler-sfc"));
}
