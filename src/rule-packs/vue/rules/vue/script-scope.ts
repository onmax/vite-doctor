import { parseForESLint } from "@typescript-eslint/parser";
import type { SFCDescriptor } from "@vue/compiler-sfc";
import type { RuleContext, SourceFileHandle } from "../../../../core/index.js";
import { createVueScriptForParsing } from "../../../../core/internal/sfc.js";

type Parsed = ReturnType<typeof parseForESLint>;
type ScopeManager = Parsed["scopeManager"];
export type ScopeReference = ScopeManager["scopes"][number]["references"][number];
export type ScopeVariable = ScopeManager["scopes"][number]["variables"][number];

export interface ScriptScope {
  ast: Parsed["ast"];
  scopeManager: ScopeManager;
  visitorKeys: Parsed["visitorKeys"];
  /** The scope reference for each identifier node in `ast`. */
  readonly references: Map<unknown, ScopeReference>;
}

interface FileMemo {
  file: SourceFileHandle;
  text: string;
  scopes: [Map<string, ScriptScope | null>, Map<string, ScriptScope | null>];
  values: Map<string, unknown>;
}

// File Rules run file by file, so one slot shares the analyses between Rules without keeping
// every file's ESLint AST alive for the rest of the Doctor Run.
let memo: FileMemo | undefined;

function fileMemo(file: SourceFileHandle): FileMemo {
  if (memo?.file !== file || memo.text !== file.text)
    memo = { file, text: file.text, scopes: [new Map(), new Map()], values: new Map() };
  return memo;
}

export function perFile<T>(ctx: RuleContext, key: string, compute: () => T): T {
  const values = fileMemo(ctx.file).values;
  if (!values.has(key)) values.set(key, compute());
  return values.get(key) as T;
}

/** Parses `text` with typescript-eslint and analyzes its scopes once per file. */
export function scriptScope(ctx: RuleContext, text: string, jsx: boolean): ScriptScope | null {
  const scopes = fileMemo(ctx.file).scopes[jsx ? 1 : 0];
  let scope = scopes.get(text);
  if (scope === undefined) {
    scope = analyzeScript(text, jsx);
    scopes.set(text, scope);
  }
  return scope;
}

/** The scope of the file's script: the whole file, or an SFC's script blocks at their offsets. */
export function fileScriptScope(ctx: RuleContext): ScriptScope | null {
  const script = perFile(ctx, "script", () =>
    ctx.file.sfc
      ? createVueScriptForParsing(ctx.file.sfc.descriptor, ctx.file.text)
      : { text: ctx.file.text, lang: /\.[jt]sx$/.test(ctx.file.relativePath) ? "tsx" : "ts" },
  );
  return scriptScope(ctx, script.text, script.lang === "jsx" || script.lang === "tsx");
}

/** Whether the script source could spell a name matched by `pattern` (see `namePattern`). */
export function scriptMayName(ctx: RuleContext, pattern: RegExp): boolean {
  const descriptor = ctx.file.sfc?.descriptor as SFCDescriptor | undefined;
  if (!descriptor) return pattern.test(ctx.file.text);
  return [descriptor.script, descriptor.scriptSetup].some(
    (block) => !!block?.content && pattern.test(block.content),
  );
}

export function analyzeScript(text: string, jsx: boolean): ScriptScope | null {
  let parsed: Parsed;
  try {
    parsed = parseForESLint(text, { range: true, sourceType: "module", ecmaFeatures: { jsx } });
  } catch {
    return null;
  }
  const { ast, scopeManager, visitorKeys } = parsed;
  let references: Map<unknown, ScopeReference> | undefined;
  return {
    ast,
    scopeManager,
    visitorKeys,
    get references() {
      return (references ??= new Map(
        scopeManager.scopes.flatMap((scope) =>
          scope.references.map((reference) => [reference.identifier, reference] as const),
        ),
      ));
    },
  };
}
