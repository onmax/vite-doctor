import { expect, test } from "vite-plus/test";
import { transformWithOxc } from "vite";
import { runProjectFixture } from "../../src/core/testkit.ts";
import { noUnusedDefine } from "../../src/rules.ts";

async function diagnose(source: string, key = "__BUILD__", file = "src/main.ts") {
  return runProjectFixture({
    framework: "vite",
    rules: [noUnusedDefine],
    files: {
      "vite.config.ts": `export default { define: { '${key}': '1' } }`,
      [file]: source,
    },
  });
}

test.each([
  "// __BUILD__\nexport const value = 1",
  "/* console.log(__BUILD__) */ export const value = 1",
  "export const example = '__BUILD__'",
  "export const example = `__BUILD__`",
  "export const pattern = /__BUILD__/",
  "export const __BUILD__EXTRA = 1; console.log(__BUILD__EXTRA)",
  "export function render(__BUILD__: string) { return __BUILD__ }",
  "const __BUILD__ = 1; console.log(__BUILD__)",
  "import { __BUILD__ } from './other'; console.log(__BUILD__)",
  "export const obj = { __BUILD__: 1 }; console.log(obj.__BUILD__)",
  "export interface Example { __BUILD__: string }",
  "export type Example = typeof __BUILD__",
])("ignores text and local/type references: %s", async (source) => {
  expect((await diagnose(source)).diagnostics.map(({ code }) => code)).toEqual(["VITE0007"]);
});

test.each([
  "console.log(__BUILD__)",
  "export const current = __BUILD__",
  "export const current = `${__BUILD__}`",
  "export const current = { __BUILD__ }",
  "export const current = { [__BUILD__]: true }",
  "export const current = typeof __BUILD__",
  "export const current = __BUILD__ as string",
  "export const current = __BUILD__ satisfies string",
  "export function render() { return __BUILD__ }",
  "export namespace Demo { export const current = __BUILD__ }",
  "declare const __BUILD__: string; console.log(__BUILD__)",
])("recognizes unbound runtime references: %s", async (source) => {
  expect((await diagnose(source)).diagnostics).toEqual([]);
});

test.each([
  ["console.log(SETTINGS.MODE)", false],
  ["console.log(SETTINGS['MODE'])", false],
  ["console.log((SETTINGS as any).MODE)", false],
  ["console.log(SETTINGS!.MODE)", false],
  ["console.log(SETTINGS.MODEExtra)", true],
  ["console.log('SETTINGS.MODE')", true],
  ["function render(SETTINGS) { return SETTINGS.MODE }", true],
  ["declare namespace SETTINGS { const MODE: string }; console.log(SETTINGS.MODE)", false],
])("matches define member paths in runtime references: %s", async (source, unused) => {
  expect((await diagnose(source, "SETTINGS.MODE")).diagnostics.map(({ code }) => code)).toEqual(
    unused ? ["VITE0007"] : [],
  );
});

test.each([
  ["export const current = __BUILD__", true],
  ["declare const __BUILD__: string; export const current = __BUILD__", true],
  ["export function read(__BUILD__: string) { return __BUILD__ }", false],
  ["export const text = '__BUILD__'", false],
  ["export type Evidence = typeof __BUILD__", false],
])("matches Vite define replacement behavior: %s", async (source, replaced) => {
  const result = await transformWithOxc(source, "entry.ts", {
    define: { __BUILD__: '"doctor-replacement"' },
  });
  expect(result.code.includes("doctor-replacement")).toBe(replaced);
  expect((await diagnose(source)).diagnostics.map(({ code }) => code)).toEqual(
    replaced ? [] : ["VITE0007"],
  );
});

test("preserves conservative Vue template evidence", async () => {
  expect(
    (await diagnose("<template>{{ __BUILD__ }}</template>", "__BUILD__", "src/App.vue"))
      .diagnostics,
  ).toEqual([]);
});

test.each([
  ["export const current = <__BUILD__ />", "__BUILD__", false],
  ["export const current = <__BUILD__></__BUILD__>", "__BUILD__", false],
  ["export const current = <__BUILD__.Component />", "__BUILD__", false],
  ["export const current = <SETTINGS.MODE />", "SETTINGS.MODE", false],
  ["export const current = <div value={__BUILD__} />", "__BUILD__", true],
  ["export const current = <div>{__BUILD__}</div>", "__BUILD__", true],
  ["export const current = <div {...__BUILD__} />", "__BUILD__", true],
  ["export const current = <div>{SETTINGS.MODE}</div>", "SETTINGS.MODE", true],
  ["export const current = <__BUILD__ value={__BUILD__} />", "__BUILD__", true],
])("matches Vite define replacement in JSX: %s", async (source, key, replaced) => {
  for (const extension of ["jsx", "tsx"]) {
    const result = await transformWithOxc(source, `entry.${extension}`, {
      define: { [key]: '"doctor-replacement"' },
    });
    expect(result.code.includes("doctor-replacement")).toBe(replaced);
    expect(
      (await diagnose(source, key, `src/main.${extension}`)).diagnostics.map(({ code }) => code),
    ).toEqual(replaced ? [] : ["VITE0007"]);
  }
});
