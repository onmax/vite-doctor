import { createRequire } from "node:module";
import type { ScopeManager } from "@typescript-eslint/scope-manager";
import type { SFCDescriptor } from "@vue/compiler-sfc";
import type { RuleContext, SourceFileHandle } from "../primitives.js";
import { parseScriptSync } from "./script.js";
import { createVueScriptForParsing } from "./sfc.js";

export type { ScopeManager };
export type ScopeReference = ScopeManager["scopes"][number]["references"][number];
export type ScopeVariable = ScopeManager["scopes"][number]["variables"][number];
export type ScopeVisitorKeys = Readonly<Record<string, readonly string[] | undefined>>;

/**
 * The script dialects typescript-estree parses: TypeScript, TSX, and JavaScript with JSX, which is
 * how TypeScript reads `.js` files.
 */
export type ScopeDialect = "ts" | "tsx" | "jsx";

export interface ScriptScope {
  /** A TS-ESTree Program: nodes carry `range`, and parentheses produce no nodes. */
  ast: any;
  readonly scopeManager: ScopeManager;
  readonly visitorKeys: ScopeVisitorKeys;
  /** The scope reference for each identifier node in `ast`. */
  readonly references: Map<unknown, ScopeReference>;
}

const require = createRequire(import.meta.url);
let scopeTools:
  | {
      analyze: typeof import("@typescript-eslint/scope-manager").analyze;
      visitorKeys: ScopeVisitorKeys;
    }
  | undefined;

// Deferred so that registering Rule Packs does not load scope analysis on every run.
function loadScopeTools() {
  return (scopeTools ??= {
    analyze: (
      require("@typescript-eslint/scope-manager") as typeof import("@typescript-eslint/scope-manager")
    ).analyze,
    visitorKeys: (
      require("@typescript-eslint/visitor-keys") as typeof import("@typescript-eslint/visitor-keys")
    ).visitorKeys,
  });
}

/** The dialect typescript-estree picks for `path`, falling back to `jsx` for other extensions. */
export function scopeDialect(path: string, jsx = false): ScopeDialect {
  if (/\.[cm]?jsx?$/.test(path)) return "jsx";
  if (path.endsWith(".tsx")) return "tsx";
  if (/\.[cm]?ts$/.test(path)) return "ts";
  return jsx ? "tsx" : "ts";
}

/**
 * Parses `source` with oxc into the TS-ESTree shape and lazily analyzes its scopes with
 * `@typescript-eslint/scope-manager`, matching what typescript-eslint's `parseForESLint` returns.
 * `sourceType` defaults to `script` as in ESLint. Throws on syntax errors.
 */
export function parseScriptScope(
  source: string,
  options: { dialect?: ScopeDialect; sourceType?: "module" | "script" } = {},
): ScriptScope {
  const dialect = options.dialect ?? "ts";
  const sourceType = options.sourceType ?? "script";
  // Script-mode oxc rejects `import.meta` and other syntax the TypeScript parser accepts in
  // expression fragments, so parse as a module and apply the source type to scope analysis.
  const result = parseScriptSync(`source.${dialect}`, source, {
    lang: dialect,
    sourceType: "module",
    astType: "ts",
    range: true,
    preserveParens: false,
  });
  const error = result.errors.find((item) => item.severity === "Error");
  if (error) throw new SyntaxError(error.message);
  const ast = result.program as any;
  ast.sourceType = sourceType;
  let scopeManager: ScopeManager | undefined;
  let references: Map<unknown, ScopeReference> | undefined;
  return {
    ast,
    get scopeManager() {
      return (scopeManager ??= loadScopeTools().analyze(ast, { sourceType }));
    },
    get visitorKeys() {
      return loadScopeTools().visitorKeys;
    },
    get references() {
      return (references ??= new Map(
        this.scopeManager.scopes.flatMap((scope) =>
          scope.references.map((reference) => [reference.identifier, reference] as const),
        ),
      ));
    },
  };
}

/** Parses a module with `parseScriptScope`, or returns null on syntax errors. Not shared. */
export function analyzeScript(text: string, dialect: ScopeDialect): ScriptScope | null {
  try {
    return parseScriptScope(text, { dialect, sourceType: "module" });
  } catch {
    return null;
  }
}

interface FileMemo {
  file: SourceFileHandle;
  text: string;
  scopes: Map<ScopeDialect, Map<string, ScriptScope | null>>;
  values: Map<string, unknown>;
}

// File Rules run file by file, so one slot per Doctor Run shares the analyses between Rules
// without keeping every file's AST alive for the rest of the run. Keying the slot by the run's
// Project Inventory lets a long-lived Doctor process release the run once it ends.
const memos = new WeakMap<object, FileMemo>();

function fileMemo(file: SourceFileHandle): FileMemo {
  let memo = memos.get(file.project);
  if (memo?.file !== file || memo.text !== file.text) {
    memo = { file, text: file.text, scopes: new Map(), values: new Map() };
    memos.set(file.project, memo);
  }
  return memo;
}

export function perFile<T>(ctx: RuleContext, key: string, compute: () => T): T {
  const values = fileMemo(ctx.file).values;
  if (!values.has(key)) values.set(key, compute());
  return values.get(key) as T;
}

/**
 * Analyzes `text`, a module in the Rule's current file, once per file and dialect for all Rules.
 * The shared AST must not be mutated. Returns null on syntax errors.
 */
export function scriptScope(
  ctx: RuleContext,
  text: string,
  dialect: ScopeDialect,
): ScriptScope | null {
  const scopes = fileMemo(ctx.file).scopes;
  let byText = scopes.get(dialect);
  if (!byText) scopes.set(dialect, (byText = new Map()));
  let scope = byText.get(text);
  if (scope === undefined) {
    scope = analyzeScript(text, dialect);
    byText.set(text, scope);
  }
  return scope;
}

/** The scope of the whole file text, parsed as TypeScript, or TSX for `.jsx` and `.tsx` files. */
export function fileTextScope(ctx: RuleContext): ScriptScope | null {
  return scriptScope(ctx, ctx.file.text, /\.[jt]sx$/.test(ctx.file.relativePath) ? "tsx" : "ts");
}

/** The file's script source: the whole file, or an SFC's script blocks at their offsets. */
export function fileScript(ctx: RuleContext): { text: string; dialect: ScopeDialect } {
  return perFile(ctx, "script", () => {
    if (!ctx.file.sfc) {
      return {
        text: ctx.file.text,
        dialect: /\.[jt]sx$/.test(ctx.file.relativePath) ? "tsx" : "ts",
      };
    }
    const script = createVueScriptForParsing(ctx.file.sfc.descriptor, ctx.file.text);
    return {
      text: script.text,
      dialect: script.lang === "jsx" || script.lang === "tsx" ? "tsx" : "ts",
    };
  });
}

/** The scope of the file's script: the whole file, or an SFC's script blocks at their offsets. */
export function fileScriptScope(ctx: RuleContext): ScriptScope | null {
  const script = fileScript(ctx);
  return scriptScope(ctx, script.text, script.dialect);
}

/** Whether the script source could spell a name matched by `pattern` (see `namePattern`). */
export function scriptMayName(ctx: RuleContext, pattern: RegExp): boolean {
  const descriptor = ctx.file.sfc?.descriptor as SFCDescriptor | undefined;
  if (!descriptor) return pattern.test(ctx.file.text);
  return [descriptor.script, descriptor.scriptSetup].some(
    (block) => !!block?.content && pattern.test(block.content),
  );
}
