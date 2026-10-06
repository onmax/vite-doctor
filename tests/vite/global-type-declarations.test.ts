import { expect, test } from "vite-plus/test";
import ts from "typescript";
import { runProjectFixture } from "../../src/core/testkit.ts";
import { noUntypedDefine, noUntypedEnv } from "../../src/rules.ts";

async function diagnose(declaration: string) {
  return runProjectFixture({
    framework: "vite",
    rules: [noUntypedDefine, noUntypedEnv],
    files: {
      "vite.config.ts": "export default { define: { __BUILD__: '1' } }",
      "src/main.ts": "console.log(__BUILD__, import.meta.env.VITE_API_URL)",
      "src/vite-env.d.ts": declaration,
    },
  });
}

test.each([
  "declare global { const __BUILD__: string; interface ImportMetaEnv { VITE_API_URL: string } }\nexport = function legacy(): T;",
  "declare global { const __BUILD__: string }\nexport = function legacy(): T;\ndeclare global { interface ImportMetaEnv { VITE_API_URL: string } }",
  "declare global { const __BUILD__: string; interface ImportMetaEnv { VITE_API_URL: string } }\nexport = function legacy(): T;\nexport = function other(): T;",
])("does not report missing declarations when parsing is incomplete: %s", async (source) => {
  expect((await diagnose(source)).diagnostics).toEqual([]);
});

test.each([
  "declare const __BUILD__: string; interface ImportMetaEnv { readonly VITE_API_URL: string }",
  "declare let __BUILD__: string; interface ImportMetaEnv { 'VITE_API_URL': string }",
  "declare var other: string, __BUILD__: string; interface ImportMetaEnv { VITE_API_URL?: string }",
  "const __BUILD__: string; interface ImportMetaEnv { VITE_API_URL: string }",
  "export {}; declare global { const __BUILD__: string; interface ImportMetaEnv { VITE_API_URL: string } }",
  "import type { Config } from './config'; declare global { const __BUILD__: Config; interface ImportMetaEnv { VITE_API_URL: string } }",
  "declare const __BUILD__: string; interface ImportMetaEnv { ['VITE_API_URL']: string }",
  "declare const __BUILD__: string; interface ImportMetaEnv { get VITE_API_URL(): string }",
  "declare const __BUILD__: string; interface ImportMetaEnv { set VITE_API_URL(value: string) }",
  "declare const __BUILD__: string; interface ImportMetaEnv { OTHER: string }; interface ImportMetaEnv { VITE_API_URL: string }",
  "declare const __BUILD__: string; interface BaseEnv { VITE_API_URL: string }; interface ImportMetaEnv extends BaseEnv {}",
  "declare const __BUILD__: string; interface BaseEnv { OTHER: string }; interface MiddleEnv extends BaseEnv { VITE_API_URL: string }; interface ImportMetaEnv extends MiddleEnv {}",
])("accepts global declaration evidence: %s", async (source) => {
  expect((await diagnose(source)).diagnostics).toEqual([]);
});

test.each([
  "export declare const __BUILD__: string; export interface ImportMetaEnv { VITE_API_URL: string }",
  "export {}; declare const __BUILD__: string; interface ImportMetaEnv { VITE_API_URL: string }",
  "import type { Config } from './config'; declare const __BUILD__: Config; interface ImportMetaEnv { VITE_API_URL: string }",
  "declare namespace Other { const __BUILD__: string; interface ImportMetaEnv { VITE_API_URL: string } }",
  "declare module 'other' { const __BUILD__: string; interface ImportMetaEnv { VITE_API_URL: string } }",
  "export as namespace Example; export declare const __BUILD__: string; export interface ImportMetaEnv { VITE_API_URL: string }",
  "// declare const __BUILD__: string; interface ImportMetaEnv { VITE_API_URL: string }",
  "/* declare const __BUILD__: string; interface ImportMetaEnv { VITE_API_URL: string } */",
  "type Example = 'declare const __BUILD__: string; interface ImportMetaEnv { VITE_API_URL: string }'",
  "declare const __BUILD__EXTRA: string; interface ImportMetaEnvExtra { VITE_API_URL: string }",
])("does not mistake local declarations or text for global types: %s", async (source) => {
  const result = await diagnose(source);
  expect(result.diagnostics.map(({ code }) => code).sort()).toEqual(["VITE0006", "VITE0011"]);
});

test.each([
  "interface ImportMetaEnv {}; interface Other { VITE_API_URL: string }",
  "interface ImportMetaEnv { OTHER: { VITE_API_URL: string } }",
  "interface ImportMetaEnv { OTHER: 'VITE_API_URL' }",
  "interface ImportMetaEnv { /* VITE_API_URL: string */ }",
  "interface ImportMetaEnv { [VITE_API_URL]: string }",
  "interface BaseEnv { VITE_API_URL: string }; interface ImportMetaEnv extends Other.BaseEnv {}",
  "interface BaseEnv extends ImportMetaEnv {}; interface ImportMetaEnv extends BaseEnv {}",
])("requires an actual ImportMetaEnv property: %s", async (source) => {
  const result = await diagnose(`declare const __BUILD__: string; ${source}`);
  expect(result.diagnostics.map(({ code }) => code)).toEqual(["VITE0011"]);
});

test.each([
  ["declare const __BUILD__: string; interface ImportMetaEnv { VITE_API_URL: string }", true],
  [
    "declare const __BUILD__: string; interface Environment { VITE_API_URL: string }; interface ImportMetaEnv extends Environment {}",
    true,
  ],
  [
    "export {}; declare global { const __BUILD__: string; interface Environment { VITE_API_URL: string }; interface ImportMetaEnv extends Environment {} }",
    true,
  ],
  [
    "export {}; declare global { const __BUILD__: string; interface ImportMetaEnv { VITE_API_URL: string } }",
    true,
  ],
  [
    "export declare const __BUILD__: string; export interface ImportMetaEnv { VITE_API_URL: string }",
    false,
  ],
  [
    "export {}; declare const __BUILD__: string; interface ImportMetaEnv { VITE_API_URL: string }",
    false,
  ],
])("agrees with TypeScript's global declaration scope: %s", async (declaration, global) => {
  const sources = new Map([
    [
      "/app/vite-env.d.ts",
      ts.createSourceFile("/app/vite-env.d.ts", declaration, ts.ScriptTarget.Latest),
    ],
    [
      "/app/main.ts",
      ts.createSourceFile(
        "/app/main.ts",
        "export const build = __BUILD__; export const url = ({} as ImportMetaEnv).VITE_API_URL",
        ts.ScriptTarget.Latest,
      ),
    ],
  ]);
  const host = ts.createCompilerHost({ noLib: true });
  host.getSourceFile = (file) => sources.get(file);
  const program = ts.createProgram([...sources.keys()], { noLib: true, noEmit: true }, host);
  const semantic = program.getSemanticDiagnostics(sources.get("/app/main.ts"));
  expect(semantic.map((diagnostic) => diagnostic.code)).toEqual(global ? [] : [2304, 2304]);
  expect((await diagnose(declaration)).diagnostics.map(({ code }) => code).sort()).toEqual(
    global ? [] : ["VITE0006", "VITE0011"],
  );
});
