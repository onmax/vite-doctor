import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parse as parseSfc } from "@vue/compiler-sfc";
import { parseSync } from "oxc-parser";
import { dirname, join } from "pathe";
import ts from "typescript";
import { describe, expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.js";
import type { DoctorRunOptions } from "../../../src/core/config.js";
import { runViteDoctor } from "../../../src/doctor.js";
import type { RuleContext } from "../../../src/core/index.js";
import { safetyNoteComments } from "../../../src/rule-packs/typescript/rules/safety-comment.js";
import { scriptComments } from "../../../src/rule-packs/typescript/rules/shared.js";
import {
  noComments,
  requireSafetyCommentForTypeAssertion,
  typescriptRulePack,
} from "../../../src/rule-packs/typescript/index.js";
import { cases as safetyCases } from "./safety-comment-cases.js";

const ruleId = "typescript/strict/no-comments";
// Vitest reads this pragma anywhere in a test file's text, string literals included.
const vitestEnvironment = ["@vitest", "environment"].join("-");

async function run(files: Record<string, string>, options?: Record<string, unknown>) {
  const result = await runProjectFixture({
    framework: "vite",
    rules: [noComments],
    files,
    config: { extends: [], rules: { [ruleId]: options ? ["warn", options] : "warn" } },
  });
  return result.diagnostics.filter((item) => item.ruleId === ruleId);
}

async function reported(files: Record<string, string>, options?: Record<string, unknown>) {
  const [file, source] = Object.entries(files)[0]!;
  const found = await run({ [file]: source }, options);
  return found.map((item) => source.slice(item.range!.start, item.range!.end));
}

describe("kept comments", () => {
  test.each([
    ["exported function JSDoc", "/** Opens a store. */\nexport function open() {}"],
    [
      "exported interface member",
      "export interface Store {\n  /** The store name. */\n  name: string\n}",
    ],
    [
      "exported union members",
      'export type Mode =\n  /** Reads only. */\n  | "read"\n  /** Reads and writes. */\n  | "write"',
    ],
    ["exported class member", "export class Store {\n  /** Opens it. */\n  open() {}\n}"],
    ["exported enum member", "export enum Mode {\n  /** Reads only. */\n  Read,\n}"],
    ["exported default", "/** The store. */\nexport default {}"],
    ["@ts-expect-error", "// @ts-expect-error the value is untyped\nconst a: string = 1"],
    ["@ts-nocheck", "// @ts-nocheck\nexport {}"],
    [
      "SAFETY note and its continuation",
      '// SAFETY: the schema checked the value,\n// and JSON has no other shape.\nconst b = JSON.parse("1") as number',
    ],
    ["block SAFETY note", "/* SAFETY: checked. */\nconst b = input as number"],
    ["JSDoc SAFETY note", "/**\n * SAFETY: checked.\n */\nconst b = input as number"],
    ["pure annotation", "const e = /*#__PURE__*/ Object.freeze({})"],
    ["at pure annotation", "const e = /* @__PURE__ */ Object.freeze({})"],
    ["no side effects", "/* #__NO_SIDE_EFFECTS__ */\nexport function f() {}"],
    ["vite-ignore", 'const env = () => import(/* @vite-ignore */ "#env")'],
    ["webpack magic", 'const page = () => import(/* webpackChunkName: "page" */ "./page")'],
    ["vue-ignore", "// @vue-ignore\nexport {}"],
    ["eslint directive", "// eslint-disable-next-line no-console\nconsole.log(1)"],
    ["eslint block", "/* eslint-disable */\nexport {}"],
    ["oxlint directive", "// oxlint-disable-next-line no-console\nconsole.log(1)"],
    ["doctor directive", "// doctor-disable-next-line typescript/x -- reason\nexport {}"],
    ["nuxt-doctor directive", "// nuxt-doctor-disable-next-line nuxt/x -- reason\nexport {}"],
    ["vite-doctor directive", "// vite-doctor-enable\nexport {}"],
    ["prettier-ignore", "// prettier-ignore\nconst m = [1,0,\n0,1]"],
    ["oxfmt-ignore", "// oxfmt-ignore\nconst m = [1]"],
    ["dprint-ignore", "// dprint-ignore\nconst m = [1]"],
    ["biome-ignore", "// biome-ignore lint: reason\nconst m = [1]"],
    ["eslint globals", "/* global window */\nexport {}"],
    ["v8 ignore", "/* v8 ignore next */\nexport {}"],
    ["c8 ignore", "/* c8 ignore next */\nexport {}"],
    ["istanbul ignore", "/* istanbul ignore next */\nexport {}"],
    ["vitest environment", `// ${vitestEnvironment} node\nexport {}`],
    ["JSDoc vitest environment", `/** ${vitestEnvironment} node */\nexport {}`],
    ["jsx pragma", "/** @jsxImportSource vue */\nexport {}"],
    ["triple-slash reference", '/// <reference types="vite/client" />\nexport {}'],
    ["preserved banner", "/*! Store v1 */\nexport {}"],
    ["license", "/**\n * @license MIT\n */\nexport {}"],
    ["preserve", "/* @preserve keep */\nexport {}"],
    ["source map", "export {}\n//# sourceMappingURL=index.js.map"],
  ])("%s", async (_name, source) => {
    expect(await reported({ "src/index.ts": source })).toEqual([]);
  });

  test("skips the hashbang line", async () => {
    expect(await reported({ "src/cli.ts": "#!/usr/bin/env node\nconsole.log(1)\n" })).toEqual([]);
  });

  test("keeps typed JSDoc in JavaScript files only", async () => {
    const typed =
      "/** @type {number} */\nconst f = 1\n/** @template T\n * @param {T} value\n */\nfunction id(value) { return value }\n";
    expect(await reported({ "scripts/example.mjs": typed })).toEqual([]);
    expect(await reported({ "src/index.ts": typed })).toEqual([
      "/** @type {number} */",
      "/** @template T\n * @param {T} value\n */",
    ]);
  });
});

describe("reported comments", () => {
  test("keeps local exports and their members, not implementation-local declarations", async () => {
    const source = `
/** Opens a store. */
function open() {}
/** A store. */
class Store {
  /** Reads the store. */
  read() {}
}
export { open as start }
export default Store
export function work() {
  class Local {
    /** Internal implementation. */
    read() {}
  }
}
/** Not a local export. */
function remote() {}
export { remote } from './elsewhere'
`;
    expect(await reported({ "src/index.ts": source })).toEqual([
      "/** Internal implementation. */",
      "/** Not a local export. */",
    ]);
  });

  test.each([
    ["/* note\n */", "function read() { return /* note\n */ 42; }", "line breaks"],
    ["/**/", "const/**/value = 1", "space"],
  ])("reports %s with guidance to preserve syntax", async (comment, source, guidance) => {
    const [found] = await run({ "src/index.ts": source });
    expect(source.slice(found!.range!.start, found!.range!.end)).toBe(comment);
    expect(found!.suggestion).toContain(guidance);
  });

  test("keeps Vue tooling pragmas and Doctor directives after prose", async () => {
    const source = `<script setup lang="ts">
/* Prose first.
 * doctor-disable-next-line typescript/strict/require-safety-comment-for-type-assertion -- explained
 */ const n = input as number
// Ordinary script note.
</script>
<template>
  <!-- @vue-expect-error -->
  <div>{{ missing }}</div>
  <!-- @vue-skip -->
  <div />
  <!-- @vue-generic {string} -->
  <Widget />
  <!-- Prose first.
    doctor-disable-next-line vue/example -- explained
  -->
  <span />
  <!-- Ordinary template note. -->
</template>`;
    expect(await reported({ "src/App.vue": source })).toEqual([
      "// Ordinary script note.",
      "<!-- Ordinary template note. -->",
    ]);
  });

  test("keeps semantic JSDoc and ESLint exports independently of API docs", async () => {
    expect(
      await reported(
        {
          "src/index.cjs": `/* exported boot */
function boot() {}
class Store { /** @readonly */ value = 1 }
/** Ordinary docs. */
module.exports = Store`,
        },
        { apiDocs: "none" },
      ),
    ).toEqual(["/** Ordinary docs. */"]);
    expect(
      await reported(
        {
          "src/index.ts": `/** @internal */
export const hidden = 1
/** Ordinary docs. */
export const visible = 2`,
        },
        { apiDocs: "none" },
      ),
    ).toEqual(["/** Ordinary docs. */"]);
  });

  test("reads a SAFETY comment run a linear number of times", () => {
    let reads = 0;
    const line = "// UNSAFETY: ordinary prose\n";
    const count = 100;
    const comments = Array.from({ length: count }, (_, index) => ({
      type: "Line" as const,
      start: index * line.length,
      end: (index + 1) * line.length - 1,
      get value() {
        reads++;
        return " UNSAFETY: ordinary prose";
      },
    }));
    expect(safetyNoteComments(line.repeat(count), comments).size).toBe(0);
    expect(reads).toBeLessThanOrEqual(2 * count);
  });

  test.each([true, false])("checks comment ordering once per file (sorted: %s)", (sorted) => {
    let reads = 0;
    const comments = Array.from({ length: 100 }, (_, index) => ({
      get start() {
        reads++;
        return sorted ? index : 100 - index;
      },
    }));
    const ctx = { file: { scriptAst: { comments } } } as unknown as RuleContext;
    const ordered = scriptComments(ctx);
    expect(ordered.map((comment) => comment.start)).toEqual(
      Array.from({ length: 100 }, (_, index) => (sorted ? index : index + 1)),
    );
    const initialReads = reads;
    for (let run = 0; run < 100; run++) expect(scriptComments(ctx)).toBe(ordered);
    expect(reads).toBe(initialReads);
  });
  test.each([
    [
      "line comment before an exported function",
      "// Opens a store.\nexport function open() {}",
      ["// Opens a store."],
    ],
    [
      "JSDoc on a declaration that is not exported",
      "/** Not exported. */\nfunction close() {}",
      ["/** Not exported. */"],
    ],
    [
      "comment on an object member",
      "const codes = {\n  // A store answered with an error.\n  other: 1,\n}",
      ["// A store answered with an error."],
    ],
    [
      "note after a SAFETY note and code",
      "// SAFETY: checked.\nconst h = 1\n// A later note.\nconst i = 2",
      ["// A later note."],
    ],
    [
      "note separated from a SAFETY note by a blank line",
      "// SAFETY: checked.\n\n// A later note.\nconst i = input as number",
      ["// A later note."],
    ],
    [
      "note before a SAFETY note",
      "// A note.\n// SAFETY: checked.\nconst i = input as number",
      ["// A note."],
    ],
    ["trailing note", "const j = 1 // trailing note", ["// trailing note"]],
    [
      "JSDoc separated by code",
      "/** Opens. */\nconst x = 1; export function open() {}",
      ["/** Opens. */"],
    ],
  ])("%s", async (_name, source, expected) => {
    expect(await reported({ "src/index.ts": source })).toEqual(expected);
  });

  test("reports comments in JavaScript files", async () => {
    expect(await reported({ "scripts/build.mjs": "// Build it.\nexport const a = 1\n" })).toEqual([
      "// Build it.",
    ]);
    expect(
      await reported({ "scripts/build.cjs": "/* Build it. */\nmodule.exports = 1\n" }),
    ).toEqual(["/* Build it. */"]);
  });

  test("reports JSX comments", async () => {
    expect(
      await reported({ "src/Widget.tsx": "export const W = () => <div>{/* jsx note */}</div>\n" }),
    ).toEqual(["/* jsx note */"]);
    expect(
      await reported({ "src/Widget.jsx": "export const W = () => <div>{/* jsx note */}</div>\n" }),
    ).toEqual(["/* jsx note */"]);
  });

  test("reports both Vue script blocks and the template, and keeps directives", async () => {
    const source = [
      '<script lang="ts">',
      "// plain script note",
      "export default {}",
      "</script>",
      '<script setup lang="ts">',
      "// setup note",
      "const count = 1 /* trailing */",
      "// SAFETY: checked above.",
      "const n = count as number",
      "</script>",
      "<template>",
      "  <!-- template note -->",
      "  <div>",
      "    <!-- eslint-disable-next-line vue/no-v-html -->",
      '    <p v-html="n" />',
      "  </div>",
      "</template>",
      "<style>",
      "/* style note */",
      ".a { color: red }",
      "</style>",
      "",
    ].join("\n");
    expect(await reported({ "src/App.vue": source })).toEqual([
      "// plain script note",
      "// setup note",
      "/* trailing */",
      "<!-- template note -->",
    ]);
  });

  test("reports template comments in a Vue file without script", async () => {
    expect(
      await reported({ "src/App.vue": "<template>\n  <!-- note -->\n  <div />\n</template>\n" }),
    ).toEqual(["<!-- note -->"]);
  });

  test("reports comments in a JavaScript Vue script", async () => {
    expect(
      await reported({ "src/App.vue": "<script setup>\n// note\nconst a = 1\n</script>\n" }),
    ).toEqual(["// note"]);
  });
});

describe("options", () => {
  test("rejects invalid options even when there are no scanned source files", async () => {
    await expect(
      runFixture({}, { config: { rules: { [ruleId]: ["warn", { allow: ["("] }] } } }),
    ).rejects.toMatchObject({ code: "DOC0020" });
  });
  test("allow keeps comments a project's tools read", async () => {
    const source = [
      "// provider-message-match: the binding has no code.",
      "const c = 1",
      'const env = () => import(/* @vite-ignore */ /* @vitehub-env */ "#env")',
      "const codes = {",
      "  // Runtime errors.",
      "  EXAMPLE_FAILED: 1,",
      "}",
      "// Not allowed.",
      "",
    ].join("\n");
    expect(await reported({ "src/index.ts": source })).toHaveLength(4);
    expect(
      await reported(
        { "src/index.ts": source },
        {
          allow: [
            "^\\s*provider-message-match:",
            "^\\s*@vitehub-",
            "^\\s*[A-Z][\\w -]{2,40}errors?\\.?\\s*$",
          ],
        },
      ),
    ).toEqual(["// Not allowed."]);
  });

  test("allow applies to template comments", async () => {
    expect(
      await reported(
        { "src/App.vue": "<template>\n  <!-- @island -->\n  <div />\n</template>\n" },
        { allow: ["^\\s*@island"] },
      ),
    ).toEqual([]);
  });

  test('apiDocs "none" reports JSDoc on exported declarations', async () => {
    const source = "/** Opens a store. */\nexport function open() {}";
    expect(await reported({ "src/index.ts": source }, { apiDocs: "none" })).toEqual([
      "/** Opens a store. */",
    ]);
    expect(await reported({ "src/index.ts": source }, { apiDocs: "exported" })).toEqual([]);
  });

  test("overrides narrow apiDocs by path", async () => {
    const source = "/** Opens a store. */\nexport function open() {}\n";
    const result = await runProjectFixture({
      framework: "vite",
      rules: [noComments],
      files: { "packages/store/src/index.ts": source, "scripts/open.ts": source },
      config: {
        extends: [],
        rules: { [ruleId]: ["warn", { apiDocs: "none" }] },
        overrides: [
          { files: ["packages/*/src/**"], rules: { [ruleId]: ["warn", { apiDocs: "exported" }] } },
        ],
      },
    });
    expect(result.diagnostics.map((item) => item.file)).toEqual([
      expect.stringMatching(/scripts\/open\.ts$/),
    ]);
  });

  test.each([
    [{ allow: ["("] }, "`allow[0]` is not a valid regular expression"],
    [{ allow: "x" }, "`allow` must be an array"],
    [{ apiDocs: "all" }, '`apiDocs` must be "exported" or "none"'],
    [{ allowed: [] }, "unknown option `allowed`"],
  ])("rejects invalid options %j", async (options, reason) => {
    await expect(run({ "src/index.ts": "// note\nexport {}" }, options)).rejects.toMatchObject({
      code: "DOC0020",
      message: expect.stringContaining(reason),
    });
  });
});

describe("fingerprints", () => {
  const base = [
    "export function load() {",
    "  // first note",
    "  const a = 1",
    "  // second note",
    "  const b = 2",
    "  return a + b",
    "}",
    "",
  ].join("\n");
  const fingerprints = async (source: string) =>
    (await run({ "src/a.ts": source })).map((item) => item.fingerprint);

  test("survive a rename of the enclosing function and a declaration inserted above", async () => {
    const before = await fingerprints(base);
    expect(before).toHaveLength(2);
    expect(await fingerprints(base.replace("load", "loadAll"))).toEqual(before);
    expect(await fingerprints(base.replace("  // first", "  const z = 0\n  // first"))).toEqual(
      before,
    );
  });

  test("change when the comment is reworded", async () => {
    const [first, second] = await fingerprints(base);
    const reworded = await fingerprints(base.replace("first note", "first note, reworded"));
    expect(reworded[0]).not.toBe(first);
    expect(reworded[1]).toBe(second);
  });

  test("differ for identical comments in one file", async () => {
    const found = await fingerprints(base.replace("second note", "first note"));
    expect(found).toHaveLength(2);
    expect(new Set(found).size).toBe(2);
  });
});

describe("TS0008 SAFETY notes", () => {
  test.each(safetyCases.filter(([, , expected]) => expected === 0))(
    "neither Rule reports %s",
    async (_name, source) => {
      const result = await runProjectFixture({
        framework: "vite",
        rules: [noComments, requireSafetyCommentForTypeAssertion],
        files: { "index.ts": source },
      });
      expect(result.diagnostics.map((item) => item.code)).toEqual([]);
    },
  );
});

describe("presets", () => {
  test("is in no Preset", () => {
    expect(typescriptRulePack.rules.map((rule) => rule.meta.id)).toContain(ruleId);
    expect(typescriptRulePack.presets.recommended).not.toContain(ruleId);
    expect(typescriptRulePack.presets.strict).not.toContain(ruleId);
    expect(typescriptRulePack.presets.strict).toEqual(
      typescriptRulePack.rules.map((rule) => rule.meta.id).filter((id) => id !== ruleId),
    );
  });

  const files = { "src/index.ts": "// A note.\nexport const a = 1\n" };

  test("--strict does not report TS0017", async () => {
    const result = await runFixture(files, { extends: ["strict"] });
    expect(result.diagnostics.map((item) => item.code)).not.toContain("TS0017");
  });

  test("naming the Rule in config turns it on", async () => {
    const result = await runFixture(files, { config: { rules: { [ruleId]: "warn" } } });
    expect(result.diagnostics.filter((item) => item.code === "TS0017")).toHaveLength(1);
  });

  test("naming the Rule in config turns it on in a JavaScript-only project", async () => {
    const result = await runFixture(
      { "src/index.js": "// A note.\nexport const a = 1\n" },
      { config: { rules: { [ruleId]: "warn" } } },
    );
    expect(result.diagnostics.filter((item) => item.code === "TS0017")).toHaveLength(1);
  });
});

describe("unsafe fix", () => {
  const script = `// Leading note.

import { a } from "./a"

export function f(b: number) {
  // Alone in a block.

  const c = a + b // trailing note
  const d = a /* inline */ + b
  const e = a/**/+b
  const g = [a,/* first */b]
  /*
   * Multi-line note.
   */
  const h = c

  // First of a run.
  // Second of a run.

  // After a blank line.
  return /* before the value */ c + d + e + g.length + h
}

function asi() {
  return /* a line break
  */ 1
}

export const kept = asi() // eslint-disable-line no-console
`;
  const jsx = `export function Widget() {
  return (
    <ul>
      {/* Alone on its line. */}
      <li>first</li>
      <li>{/* inline */}</li>
      <li>
        text
        {/* between words */}
        more
      </li>
      <li>
        text
        {/* first between words */}
        {/* second between words */}
        more
      </li>
      <li>
        {/* above the text */}
        last
      </li>
    </ul>
  )
}
`;
  const vue = `<script setup lang="ts">
// Setup note.
const count = 1 /* trailing */
</script>

<template>
  <!-- Alone in the template. -->
  <div>
    <span>a</span><!-- touching --><span>b</span>
    <span>c</span> <!-- spaced --> <span>d</span>
    {{ count }}
    <!-- next to text -->
    <!-- eslint-disable-next-line vue/no-v-html -->
    <p v-html="count" />
  </div>
  <pre>
    <!-- in pre -->
  </pre>
</template>
`;
  const crlf = "// Note.\r\nconst a = 1 // trailing\r\nexport { a }\r\n";
  const files = {
    "src/index.ts": script,
    "src/Widget.tsx": jsx,
    "src/App.vue": vue,
    "src/crlf.ts": crlf,
  };

  test("plain --fix leaves every comment in place", async () => {
    const { after, result } = await fixFixture(files, { fix: true });
    expect(after).toEqual(files);
    expect(result.fixes?.edits ?? 0).toBe(0);
  });

  test("--unsafe-fix deletes the comments it can delete cleanly", async () => {
    const { after, result } = await fixFixture(files, { unsafeFix: true });
    expect(after["src/index.ts"]).toBe(`import { a } from "./a"

export function f(b: number) {
  const c = a + b
  const d = a + b
  const e = a +b
  const g = [a,b]
  const h = c

  return c + d + e + g.length + h
}

function asi() {
  return /* a line break
  */ 1
}

export const kept = asi() // eslint-disable-line no-console
`);
    expect(after["src/Widget.tsx"]).toBe(`export function Widget() {
  return (
    <ul>
      <li>first</li>
      <li></li>
      <li>
        text
        {/* between words */}
        more
      </li>
      <li>
        text
        {/* first between words */}
        {/* second between words */}
        more
      </li>
      <li>
        last
      </li>
    </ul>
  )
}
`);
    expect(after["src/App.vue"]).toBe(`<script setup lang="ts">
const count = 1
</script>

<template>
  <!-- Alone in the template. -->
  <div>
    <span>a</span><span>b</span>
    <span>c</span> <!-- spaced --> <span>d</span>
    {{ count }}
    <!-- next to text -->
    <!-- eslint-disable-next-line vue/no-v-html -->
    <p v-html="count" />
  </div>
  <pre>
    <!-- in pre -->
  </pre>
</template>
`);
    expect(after["src/crlf.ts"]).toBe("const a = 1\r\nexport { a }\r\n");

    const remaining = result.diagnostics.filter((item) => item.code === "TS0017");
    expect(remaining.map((item) => item.fix)).toEqual(remaining.map(() => undefined));
    expect(remaining).toHaveLength(8);
    for (const [file, text] of Object.entries(after)) expect(parseErrors(file, text)).toEqual([]);
  });

  test.each([
    ["a comment that separates two words", "const/**/value = 1\n", "const value = 1\n"],
    ["a comment before a closing bracket", "f(a /* x */)\n", "f(a)\n"],
    ["the last comment in a file", "const a = 1\n\n// End.\n", "const a = 1\n"],
    [
      "a comment at the end of a block",
      "if (a) {\n  b()\n\n  // End.\n}\n",
      "if (a) {\n  b()\n}\n",
    ],
    ["a comment between blank lines", "a()\n\n// x\n\nb()\n", "a()\n\nb()\n"],
  ])("deletes %s", async (_name, source, expected) => {
    const { after } = await fixFixture({ "src/index.ts": source }, { unsafeFix: true });
    expect(after["src/index.ts"]).toBe(expected);
  });

  test("offers no fix where a block comment holds the line break after return", async () => {
    const [found] = await run({ "src/index.ts": "function f() {\n  return /* x\n  */ 1\n}\n" });
    expect(found!.fix).toBeUndefined();
  });

  test("reports a comment after a leading empty line without hanging", async () => {
    expect(await reported({ "src/index.ts": "\n// note\nexport {}\n" })).toEqual(["// note"]);
  });

  test("keeps separate text children of a JSX component", async () => {
    const file = "src/Widget.tsx";
    const source = `declare function Widget(props: { children: [string, string] }): any
export const view = <Widget>a{/* note */}b</Widget>
`;
    const { after, result } = await fixFixture({ [file]: source }, { unsafeFix: true });
    const output = ts.transpileModule(after[file]!, {
      fileName: file,
      compilerOptions: { jsx: ts.JsxEmit.React, jsxFactory: "h" },
    }).outputText;
    expect(output).toMatch(/h\(Widget, null,\s*"a",\s*"b"\)/);
    expect(result.diagnostics.find((item) => item.code === "TS0017")).toMatchObject({
      fix: undefined,
    });
  });

  test("does not delete Vue template whitespace under preserve", async () => {
    const file = "src/App.vue";
    const source = `<template><div><span>A</span>
<!-- note -->
<span>B</span>
<!-- on the left --><span>C</span><!-- on the right -->
<span>D</span></div></template>`;
    const { after, result } = await fixFixture({ [file]: source }, { unsafeFix: true });
    expect(after[file]).toBe(source);
    const remaining = result.diagnostics.filter((item) => item.code === "TS0017");
    expect(remaining.map((item) => item.fix)).toEqual([undefined, undefined, undefined]);
  });

  test("does not move code onto the target line of an exempt directive", async () => {
    const file = "src/index.ts";
    const protectedSource = "// eslint-disable-next-line no-console\n// note\nconsole.log(1)\n";
    const { after, result } = await fixFixture(
      { [file]: `${protectedSource}export {} // unrelated note\n` },
      { unsafeFix: true },
    );
    expect(after[file]).toBe(`${protectedSource}export {}\n`);
    expect(result.diagnostics.find((item) => item.code === "TS0017")).toMatchObject({
      fix: undefined,
    });
  });

  test("does not reactivate a shadowed JSDoc type in checkJs", async () => {
    const file = "src/index.js";
    const annotation = "/** @type {number} */";
    const shadow = "/** Labels shown on the start page. */";
    const declaration = 'const label = "start";';
    const protectedSource = [annotation, "", shadow, declaration, ""].join("\n");
    const source = `${protectedSource}/** Ordinary docs. */\nconst other = label;\n`;
    expect(typeScriptDiagnostics(file, source)).toEqual([]);
    expect(typeScriptDiagnostics(file, source.replace(shadow, ""))).toEqual([2322]);

    const { after, result } = await fixFixture({ [file]: source }, { unsafeFix: true });
    expect(after[file]).toBe(`${protectedSource}const other = label;\n`);
    expect(typeScriptDiagnostics(file, after[file]!)).toEqual([]);
    expect(result.diagnostics.filter((item) => item.code === "TS0017")).toMatchObject([
      { fix: undefined },
    ]);
  });

  test("does not activate a TypeScript suppression across an ordinary block comment", async () => {
    const file = "src/index.ts";
    const barrier = "/* The error below is intentional. */";
    const source = [
      "// @ts-expect-error",
      "// @license MIT",
      "// @preserve This notice.",
      barrier,
      'const label: number = "start";',
      "",
    ].join("\n");
    const before = typeScriptDiagnostics(file, source).sort((left, right) => left - right);
    expect(before).toEqual([2322, 2578]);
    expect(typeScriptDiagnostics(file, source.replace(barrier, ""))).toEqual([]);

    const { after, result } = await fixFixture({ [file]: source }, { unsafeFix: true });
    expect(typeScriptDiagnostics(file, after[file]!).sort((left, right) => left - right)).toEqual(
      before,
    );
    expect(after[file]).toContain(barrier);
    const diagnostics = result.diagnostics.filter((item) => item.code === "TS0017");
    expect(diagnostics).toMatchObject([{ fix: undefined }]);
  });

  test.each([
    ["v8", "\n"],
    ["c8", "\r\n"],
  ])("keeps line breaks across a counted %s coverage directive", async (tool, newline) => {
    const file = "src/index.ts";
    const protectedLines = [
      `/* ${tool} ignore next 4 */`,
      "first();",
      "second();",
      "third();",
      "// Keep the fourth line in the ignore range.",
      "outside();",
    ];
    const source = [...protectedLines, "// unrelated note", "export {}", ""].join(newline);
    const { after, result } = await fixFixture({ [file]: source }, { unsafeFix: true });
    expect(after[file]).toBe([...protectedLines, "export {}", ""].join(newline));
    expect(result.diagnostics.filter((item) => item.code === "TS0017")).toMatchObject([
      { fix: undefined },
    ]);
  });

  test("removes ordinary comments next to non-line-scoped exemptions", async () => {
    const file = "src/index.ts";
    const header = "/*! SPDX-License-Identifier: MIT */";
    const annotated = "const value = /*#__PURE__*/ makeValue();";
    const source = [header, "// note", annotated, "// another note", "export { value };", ""];
    const { after, result } = await fixFixture({ [file]: source.join("\n") }, { unsafeFix: true });
    expect(after[file]).toBe([header, annotated, "export { value };", ""].join("\n"));
    expect(result.diagnostics.filter((item) => item.code === "TS0017")).toEqual([]);
  });

  test("marks the fix unsafe", async () => {
    expect(noComments.meta.fixable).toBe("unsafe");
    const [found] = await run({ "src/index.ts": "// note\nexport {}\n" });
    expect(found!.fix).toMatchObject({
      kind: "unsafe",
      edits: [{ range: { start: 0, end: 8 }, text: "" }],
    });
  });
});

function typeScriptDiagnostics(file: string, source: string) {
  const options = { allowJs: true, checkJs: true, noEmit: true, noLib: true, types: [] };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name, languageVersion) =>
    name === file ? ts.createSourceFile(name, source, languageVersion) : undefined;
  const program = ts.createProgram([file], options, host);
  return program.getSemanticDiagnostics(program.getSourceFile(file)).map(({ code }) => code);
}

function parseErrors(file: string, text: string) {
  if (!file.endsWith(".vue")) return parseSync(file, text).errors.map((error) => error.message);
  const { descriptor, errors } = parseSfc(text, { filename: file });
  const script = descriptor.scriptSetup ?? descriptor.script;
  return [
    ...errors.map((error) => error.message),
    ...(script ? parseSync(`${file}.ts`, script.content).errors.map((error) => error.message) : []),
  ];
}

async function fixFixture(
  files: Record<string, string>,
  flags: Pick<DoctorRunOptions, "fix" | "unsafeFix">,
) {
  const root = await mkdtemp(join(tmpdir(), "vite-doctor-no-comments-fix-"));
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ type: "module", devDependencies: { vite: "^8.0.0", vue: "^3.5.0" } }),
    );
    for (const [file, source] of Object.entries(files)) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), source);
    }
    const result = await runViteDoctor({
      root,
      cache: false,
      framework: "vite",
      config: { extends: [], rules: { [ruleId]: "warn" } },
      ...flags,
    });
    const after: Record<string, string> = {};
    for (const file of Object.keys(files)) after[file] = await readFile(join(root, file), "utf8");
    return { after, result };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runFixture(
  files: Record<string, string>,
  options: Pick<DoctorRunOptions, "config" | "extends"> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "vite-doctor-no-comments-"));
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ type: "module", devDependencies: { vite: "^8.0.0" } }),
    );
    for (const [file, source] of Object.entries(files)) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), source);
    }
    return await runViteDoctor({ root, cache: false, framework: "vite", ...options });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
