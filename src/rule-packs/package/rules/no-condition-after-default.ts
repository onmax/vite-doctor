import { createRule } from "../../../core/index.js";
import { isRecord } from "../artifacts.js";
import { diagnostics } from "../diagnostics.js";
import { inRunScope, manifestPropertyRange, packageWorkspace } from "../manifests.js";

const RULE_ID = "package/no-condition-after-default";

interface ShadowedConditions {
  /** Property path from the manifest root to the conditions object. */
  path: string[];
  shadowed: string[];
}

export const noConditionAfterDefault = createRule({
  meta: {
    id: RULE_ID,
    title: "Put the default export condition last",
    description:
      'Find conditions objects in package.json "exports" where a "default" that always resolves comes before other conditions, so Node, Vite and other resolvers never reach them.',
    why: 'Resolvers walk an exports conditions object in key order and take the first key that matches. "default" matches every environment, so once it resolves to a path, an "import", "require", "node" or "browser" key after it is never read. The package then loads the "default" file everywhere, which usually means the CommonJS build for ESM consumers or the Node build in the browser.',
    recommendedReplacement:
      'Move "default" to the end of its conditions object, after every condition that should win over it.',
    examples: [
      {
        title: "Let import and require win over default",
        language: "json",
        invalid:
          '{ "exports": { ".": { "default": "./dist/index.cjs", "import": "./dist/index.mjs" } } }',
        valid:
          '{ "exports": { ".": { "import": "./dist/index.mjs", "default": "./dist/index.cjs" } } }',
      },
    ],
    category: "imports",
    severity: "warn",
    confidence: "manifest-backed",
    fixable: "suggestion",
    diagnosticCodes: ["PKG0009"],
    execution: "manifest",
    cacheScope: "run",
    consumesEvidence: ["manifest"],
    docsUrl: "https://nodejs.org/api/packages.html#conditional-exports",
  },
  create(ctx) {
    return {
      onProjectStart() {
        for (const item of packageWorkspace(ctx).packages) {
          if (item.manifest.private || !inRunScope(item)) continue;
          for (const { path, shadowed } of shadowedConditions(item.manifest.exports)) {
            const at = [...path, "default"];
            const range = manifestPropertyRange(ctx, item.file, item.text, at);
            if (!range) continue;
            const location = path.length > 1 ? ` in exports${pathLabel(path.slice(1))}` : "";
            const keys = shadowed.map((key) => `"${key}"`).join(", ");
            ctx.report(
              diagnostics.PKG0009({
                why: `"default"${location} comes before ${keys}. Resolvers take the first matching key, and "default" always matches, so ${shadowed.length === 1 ? "that condition is" : "those conditions are"} never used.`,
                fix: `Move "default" after ${keys} so it only applies when no other condition matches.`,
                sources: [`${item.file}:${range.line}:${range.column}`],
              }),
              {
                ruleId: RULE_ID,
                severity: ctx.severity,
                category: "imports",
                file: item.file,
                range,
                confidence: "manifest-backed",
                evidence: [
                  {
                    kind: "manifest",
                    file: item.file,
                    range,
                    summary: `exports${pathLabel(path.slice(1))} lists "default" before ${keys}.`,
                  },
                ],
              },
            );
          }
        }
      },
    };
  },
});

function pathLabel(path: string[]): string {
  return path.map((key) => `["${key}"]`).join("");
}

/** Conditions objects in `exports` whose runtime conditions sit after an always-matching default. */
function shadowedConditions(exports: unknown): ShadowedConditions[] {
  if (!isRecord(exports)) return [];
  const keys = Object.keys(exports);
  const subpaths = keys.filter((key) => key.startsWith("."));
  // Node rejects an exports object that mixes subpaths and conditions.
  if (subpaths.length && subpaths.length !== keys.length) return [];
  const found: ShadowedConditions[] = [];
  if (subpaths.length) {
    for (const subpath of subpaths) visit(exports[subpath], ["exports", subpath], found);
  } else visit(exports, ["exports"], found);
  return found;
}

function visit(target: unknown, path: string[], found: ShadowedConditions[]) {
  if (!isRecord(target)) return;
  const keys = Object.keys(target);
  const index = keys.indexOf("default");
  const stops = index !== -1 && alwaysResolves(target.default);
  if (stops) {
    // TypeScript moves past a "default" whose file has no declaration, so it can still read "types".
    const shadowed = keys.slice(index + 1).filter((key) => !key.startsWith("types"));
    if (shadowed.length) found.push({ path, shadowed });
  }
  for (const key of stops ? keys.slice(0, index + 1) : keys)
    visit(target[key], [...path, key], found);
}

/**
 * Node stops at a condition whose target is a path or null, or an object that itself ends in such
 * a default. Arrays and objects without a default can fall through to the next key.
 */
function alwaysResolves(target: unknown): boolean {
  if (typeof target === "string" || target === null) return true;
  return isRecord(target) && "default" in target && alwaysResolves(target.default);
}
