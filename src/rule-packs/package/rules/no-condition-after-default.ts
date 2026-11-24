import { dirname } from "pathe";
import { createRule } from "../../../core/index.js";
import type { DiagnosticEvidence } from "../../../core/primitives.js";
import { isRecord, validExportTarget } from "../artifacts.js";
import { diagnostics } from "../diagnostics.js";
import { inRunScope, manifestPropertyRange, packageWorkspace } from "../manifests.js";

const RULE_ID = "package/no-condition-after-default";

interface ShadowedConditions {
  /** Property path from the manifest root to the conditions object. */
  path: (string | number)[];
  shadowed: string[];
}

interface TargetResolution {
  /** The target cannot fall through to the next condition. */
  terminal: boolean;
  /** The target can block resolution rather than selecting a path. */
  canBlock: boolean;
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
          for (const { path, shadowed } of shadowedConditions(
            item.manifest.exports,
            dirname(item.file),
          )) {
            const at = [...path, "default"];
            const range = manifestPropertyRange(ctx, item.file, item.text, at);
            if (!range) continue;
            const location = path.length > 1 ? ` in exports${pathLabel(path.slice(1))}` : "";
            const keys = shadowed.map((key) => JSON.stringify(key)).join(", ");
            const evidence: DiagnosticEvidence[] = [
              {
                kind: "manifest",
                file: item.file,
                range,
                summary: `exports${pathLabel(path.slice(1))} lists "default" before ${keys}.`,
              },
            ];
            for (const key of shadowed) {
              const shadowedRange = manifestPropertyRange(ctx, item.file, item.text, [
                ...path,
                key,
              ]);
              if (shadowedRange)
                evidence.push({
                  kind: "manifest",
                  file: item.file,
                  range: shadowedRange,
                  summary: `${JSON.stringify(key)} is shadowed by "default".`,
                });
            }
            ctx.report(
              diagnostics.PKG0009({
                why: `"default"${location} comes before ${keys}. It always matches and cannot fall through, so ${shadowed.length === 1 ? "that runtime condition is" : "those runtime conditions are"} never used.`,
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
                evidence,
              },
            );
          }
        }
      },
    };
  },
});

function pathLabel(path: (string | number)[]): string {
  return path.map((key) => `[${JSON.stringify(key)}]`).join("");
}

/** Conditions objects in `exports` whose runtime conditions sit after an always-matching default. */
function shadowedConditions(exports: unknown, root: string): ShadowedConditions[] {
  const found: ShadowedConditions[] = [];
  if (isRecord(exports)) {
    const keys = Object.keys(exports);
    const subpaths = keys.filter((key) => key.startsWith("."));
    if (subpaths.length) {
      if (subpaths.length === keys.length)
        for (const subpath of subpaths) visit(exports[subpath], ["exports", subpath]);
      return found;
    }
  }
  visit(exports, ["exports"]);
  return found;

  function visit(target: unknown, path: (string | number)[]): TargetResolution {
    if (typeof target === "string") {
      const valid = validExportTarget(target, root);
      return { terminal: valid, canBlock: !valid };
    }
    if (target === null) return { terminal: true, canBlock: true };
    if (Array.isArray(target)) {
      let terminal = target.length === 0;
      let canBlock = terminal;
      for (const [index, entry] of target.entries()) {
        const resolution = visit(entry, [...path, index]);
        if (resolution.terminal && !resolution.canBlock) return resolution;
        terminal ||= resolution.terminal;
        canBlock ||= resolution.canBlock;
      }
      return { terminal, canBlock };
    }
    if (!isRecord(target)) return { terminal: false, canBlock: true };
    const keys = Object.keys(target).filter((key) => key !== "types" && !key.startsWith("types@"));
    let canBlock = false;
    for (const [index, key] of keys.entries()) {
      const resolution = visit(target[key], [...path, key]);
      canBlock ||= resolution.canBlock;
      if (key === "default" && resolution.terminal) {
        const shadowed = keys.slice(index + 1);
        if (shadowed.length) found.push({ path, shadowed });
        return { terminal: true, canBlock };
      }
    }
    return { terminal: false, canBlock };
  }
}
