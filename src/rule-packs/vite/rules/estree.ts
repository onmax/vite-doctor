import { createRequire } from "node:module";
import { parseSync } from "oxc-parser";
import type { ScopeManager } from "@typescript-eslint/scope-manager";
import type { AnyNode } from "./shared.js";

export interface ParsedTypeScript {
  ast: AnyNode;
  readonly scopeManager: ScopeManager;
  readonly visitorKeys: Readonly<Record<string, readonly string[] | undefined>>;
}

const require = createRequire(import.meta.url);
let scopeTools:
  | {
      analyze: typeof import("@typescript-eslint/scope-manager").analyze;
      visitorKeys: ParsedTypeScript["visitorKeys"];
    }
  | undefined;

// Deferred so that registering the vite Rule Pack does not load scope analysis on every run.
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

/**
 * Parses TypeScript with oxc into the TS-ESTree shape (`range`, no parenthesized expression
 * nodes) and lazily analyzes scopes with `@typescript-eslint/scope-manager`. Throws on syntax
 * errors.
 */
export function parseTypeScript(
  source: string,
  options: { jsx?: boolean; sourceType?: "module" | "script" } = {},
): ParsedTypeScript {
  const sourceType = options.sourceType ?? "script";
  // Script-mode oxc rejects `import.meta` and other syntax the TypeScript parser accepts in
  // expression fragments, so parse as a module and apply the source type to scope analysis.
  const result = parseSync(options.jsx ? "source.tsx" : "source.ts", source, {
    lang: options.jsx ? "tsx" : "ts",
    sourceType: "module",
    astType: "ts",
    range: true,
    preserveParens: false,
  });
  const error = result.errors.find((item) => item.severity === "Error");
  if (error) throw new SyntaxError(error.message);
  const ast = result.program as AnyNode;
  ast.sourceType = sourceType;
  let scopeManager: ScopeManager | undefined;
  return {
    ast,
    get scopeManager() {
      return (scopeManager ??= loadScopeTools().analyze(ast, { sourceType }));
    },
    get visitorKeys() {
      return loadScopeTools().visitorKeys;
    },
  };
}
