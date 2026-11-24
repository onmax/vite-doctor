import { relative } from "pathe";
import type { RuleContext } from "../../../core/index.js";
import { analyzeScript, scopeDialect } from "../../../core/internal/script-scope.js";
import { diagnostics } from "../diagnostics.js";
import { resolvesToImport, unwrapExpression, walk } from "./nitro-handlers.js";
import { nitroServerFile } from "./server-layout.js";
import { createRule } from "./shared.js";
import { isUndeclaredBase, nitroStorageInventory, normalizeBase } from "./storage-mounts.js";

const RULE_ID = "nitro/storage/no-undeclared-mount";
const STORAGE_MODULES = new Set([
  "nitropack/runtime",
  "#imports",
  "#internal/nitro",
  "nitro/storage",
  "nitro/kv",
]);
const SCRIPT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__)\/|\.(?:spec|test)\.[cm]?[jt]sx?$/;

export const noUndeclaredStorageMount = createRule({
  meta: {
    id: RULE_ID,
    title: "Mount storage before using a base in production",
    category: "storage",
    severity: "warn",
    confidence: "heuristic-medium",
    fixable: "suggestion",
    docsUrl: "https://nitro.build/guide/storage",
    execution: "workspace",
    cacheScope: "none",
    requires: { nitro: true, crossFile: true },
    requiresContext: ["cross-file"],
    consumesEvidence: ["ast"],
    cost: "medium",
  },
  create(ctx) {
    return {
      async onWorkspaceEnd() {
        const inventory = await nitroStorageInventory(ctx);
        if (!inventory.complete) return;
        for (const file of await ctx.inventory.sourcePaths()) {
          if (!SCRIPT.test(file) || /\.d\.[cm]?ts$/.test(file) || !nitroServerFile(ctx, file))
            continue;
          if (TEST_FILE.test(relative(ctx.project.root, file))) continue;
          const text = ctx.fs.readText(file);
          if (!text || !/\buse(?:Storage|KV)\b/.test(text)) continue;
          reportFile(ctx, file, text, (base) => isUndeclaredBase(inventory, base));
        }
      },
    };
  },
});

function reportFile(
  ctx: RuleContext,
  file: string,
  text: string,
  undeclared: (base: string) => boolean,
) {
  const scope = analyzeScript(text, scopeDialect(file));
  if (!scope) return;
  walk(scope, scope.ast, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = unwrapExpression(node.callee);
    if (
      !resolvesToImport(scope, callee, "useStorage", STORAGE_MODULES) &&
      !resolvesToImport(scope, callee, "useKV", STORAGE_MODULES)
    )
      return;
    const argument = node.arguments[0];
    const base =
      argument?.type === "Literal" && typeof argument.value === "string"
        ? argument.value
        : argument?.type === "TemplateLiteral" && argument.expressions.length === 0
          ? argument.quasis[0]?.value?.cooked
          : undefined;
    if (!base || !normalizeBase(base) || !undeclared(base)) return;
    const range = ctx.helpers.rangeFromOffsets(file, text, node.range[0], node.range[1]);
    const mount = normalizeBase(base).split(":")[0];
    ctx.report(
      diagnostics.NITRO0034({
        why: `${callee.name}('${base}') reads a base that no storage or kv mount in the config covers. In a production build unstorage sends those keys to its root mount, an in-memory driver, so the values vanish on restart and are not shared between server instances. A devStorage mount only applies to dev and prerender.`,
        fix: `Declare a production mount for '${mount}' under nitro.storage (Nitro 2 and Nuxt) or kv (Nitro 3), or use a base you already mount. If a plugin mounts it at runtime with useStorage().mount(), keep that and suppress this diagnostic.`,
      }),
      {
        ruleId: RULE_ID,
        severity: ctx.severity,
        category: "storage",
        file,
        range,
        confidence: "heuristic-medium",
        evidence: [
          {
            kind: "ast" as const,
            file,
            range,
            summary: `${callee.name}('${base}') with no production mount`,
          },
        ],
      },
    );
  });
}
