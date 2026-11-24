import { relative } from "pathe";
import type { RuleContext } from "../../../core/index.js";
import {
  analyzeScript,
  scopeDialect,
  type ScriptScope,
} from "../../../core/internal/script-scope.js";
import { diagnostics } from "../diagnostics.js";
import { isDevRoute, isNitroRuntimeFile } from "./nitro-config.js";
import {
  constInitializer,
  isStorageCall,
  memberName,
  unwrapExpression,
  walk,
} from "./nitro-handlers.js";
import { literalValue } from "./server-layout.js";
import { createRule, type AnyNode } from "./shared.js";
import {
  nitroStorageInventory,
  normalizeBase,
  storageCoverage,
  type NitroStorageInventory,
} from "./storage-mounts.js";

const RULE_ID = "nitro/storage/no-undeclared-mount";
const ITEM_METHODS = new Set([
  "has",
  "hasItem",
  "get",
  "getItem",
  "getItemRaw",
  "set",
  "setItem",
  "setItemRaw",
  "del",
  "remove",
  "removeItem",
  "getMeta",
  "setMeta",
  "removeMeta",
]);
const PREFIX_METHODS = new Set(["getKeys", "keys", "clear"]);
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
    docsUrl: "https://nitro.build/docs/storage",
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
        const inventory = nitroStorageInventory(ctx);
        if (!inventory.complete) return;
        for (const file of await ctx.inventory.sourcePaths()) {
          if (
            !SCRIPT.test(file) ||
            /\.d\.[cm]?ts$/.test(file) ||
            !isNitroRuntimeFile(ctx, file) ||
            isDevRoute(ctx, file)
          )
            continue;
          if (TEST_FILE.test(relative(ctx.project.root, file))) continue;
          const text = ctx.fs.readText(file);
          if (!text || !/\buse(?:Storage|KV)\b/.test(text)) continue;
          reportFile(ctx, file, text, inventory);
        }
      },
    };
  },
});

function reportFile(
  ctx: RuleContext,
  file: string,
  text: string,
  inventory: NitroStorageInventory,
) {
  const scope = analyzeScript(text, scopeDialect(file));
  if (!scope) return;
  const uncovered = new Map<AnyNode, string>();
  walk(scope, scope.ast, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = unwrapExpression(node.callee);
    const method = memberName(callee);
    if (method && (ITEM_METHODS.has(method) || PREFIX_METHODS.has(method))) {
      const receiver = unwrapExpression(callee.object);
      const storage = unwrapExpression(constInitializer(scope, receiver)) ?? receiver;
      const base = storageBase(scope, storage);
      const key = literalValue(node.arguments[0]);
      if (base && typeof key === "string" && normalizeBase(key)) {
        const coverage = ITEM_METHODS.has(method)
          ? storageCoverage(inventory, base, key)
          : storageCoverage(inventory, `${base}:${key}`);
        if (coverage === "unmounted") uncovered.set(storage, key);
      }
    }
  });
  walk(scope, scope.ast, (node) => {
    const base = storageBase(scope, node);
    if (!base || !normalizeBase(base)) return;
    const key = uncovered.get(node);
    if (key === undefined && storageCoverage(inventory, base) !== "unmounted") return;
    const callee = unwrapExpression(node.callee);
    const range = ctx.helpers.rangeFromOffsets(file, text, node.range[0], node.range[1]);
    const mount = normalizeBase(base).split(":")[0];
    const access = key === undefined ? "this base" : `the key '${key}' under this base`;
    ctx.report(
      diagnostics.NITRO0034({
        why: `${callee.name}('${base}') uses ${access}, which no production mount covers. In a production build unstorage sends those keys to its root mount, an in-memory driver, so the values vanish on restart and are not shared between server instances. A devStorage mount only applies to dev and prerender.`,
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

function storageBase(scope: ScriptScope, node: AnyNode) {
  if (!isStorageCall(scope, node)) return undefined;
  const base = literalValue(node.arguments[0]);
  return typeof base === "string" ? base : undefined;
}
