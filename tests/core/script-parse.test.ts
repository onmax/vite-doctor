import { parseSync, rawTransferSupported } from "oxc-parser";
import { expect, test } from "vite-plus/test";
import { parseScript, parseScriptResult, parseScriptSync } from "../../src/core/internal/script.ts";

const source = [
  "#!/usr/bin/env node",
  "// leading line",
  "/* block */",
  'const text = "caf\\u00e9 😀";',
  "const pattern = /a(?<name>b)+/giu;",
  "const big = 123n;",
  "const tpl = `x${text}y`;",
  "export default { pattern, big, tpl };",
].join("\n");

type Node = Record<string, any>;

function declarationInit(program: Node, name: string): Node {
  for (const statement of program.body) {
    for (const declaration of statement.declarations ?? []) {
      if (declaration.id.name === name) return declaration.init;
    }
  }
  throw new Error(`missing ${name}`);
}

test("parses scripts with raw transfer where the runtime supports it", () => {
  expect(rawTransferSupported()).toBe(true);
});

test("keeps the AST fields rules depend on", () => {
  const program = parseScript("/src/entry.js", source) as Node;

  expect(program.type).toBe("Program");
  expect(program.hashbang).toMatchObject({ type: "Hashbang", value: "/usr/bin/env node" });
  expect(program.comments.map((comment: Node) => [comment.type, comment.value])).toEqual([
    ["Line", "/usr/bin/env node"],
    ["Line", " leading line"],
    ["Block", " block "],
  ]);
  for (const comment of program.comments) {
    expect(source.slice(comment.start, comment.end)).toMatch(/^(#!|\/\/|\/\*)/);
  }

  const text = declarationInit(program, "text");
  expect(text).toMatchObject({ type: "Literal", value: "café 😀", raw: '"caf\\u00e9 😀"' });
  expect(source.slice(text.start, text.end)).toBe(text.raw);

  const pattern = declarationInit(program, "pattern");
  expect(pattern.regex).toEqual({ pattern: "a(?<name>b)+", flags: "giu" });
  expect(pattern.value).toBeInstanceOf(RegExp);
  expect(String(pattern.value)).toBe("/a(?<name>b)+/giu");

  const big = declarationInit(program, "big");
  expect(big).toMatchObject({ type: "Literal", value: 123n, bigint: "123", raw: "123n" });

  const tpl = declarationInit(program, "tpl");
  expect(tpl.quasis.map((quasi: Node) => quasi.value.cooked)).toEqual(["x", "y"]);
});

test("returns plain mutable nodes that later parses do not corrupt", () => {
  const first = parseScript("/src/first.ts", source) as Node;
  const snapshot = structuredClone(first);

  Object.defineProperty(first.body[0], "__doctorParent", { value: first, enumerable: false });
  for (let index = 0; index < 5; index++) {
    parseScript(
      `/src/next-${index}.ts`,
      `export const value${index} = ${"[1, 2, 3], ".repeat(500)}0;`,
    );
  }

  expect(Object.getPrototypeOf(first)).toBe(Object.prototype);
  expect(first.body[0].__doctorParent).toBe(first);
  expect(first).toEqual(snapshot);
});

test("matches the JSON transfer AST exactly", () => {
  for (const [file, lang] of [
    ["/src/entry.js", "js"],
    ["/src/entry.ts", "ts"],
  ] as const) {
    const raw = parseScriptSync(file, source, { sourceType: "module", lang });
    const json = parseSync(file, source, { sourceType: "module", lang });
    expect(raw.program).toEqual(json.program);
    expect(raw.comments).toEqual(json.comments);
    expect(Object.keys(raw.program)).toEqual(Object.keys(json.program));
  }
});

test("reports parse errors like the JSON transfer path", () => {
  const broken = "const value = ;";
  const result = parseScriptResult("/src/broken.ts", broken);
  expect(result.errors).toEqual(
    parseSync("/src/broken.ts", broken, { sourceType: "module", lang: "ts" })
      .errors.filter((error) => error.severity === "Error")
      .map((error) => error.message),
  );
  expect(result.errors.length).toBeGreaterThan(0);
});
