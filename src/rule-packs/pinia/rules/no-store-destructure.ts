import { relative } from "pathe";
import { createRule, type RuleContext } from "../../../core/index.js";
import { ownPropertyName } from "../../../core/internal/shared-state-writes.js";
import { diagnostics } from "../diagnostics.js";
import {
  collectStores,
  enclosing,
  findStoreCalls,
  storeRange,
  type AnyNode,
  type CollectedStore,
  type StoreCall,
} from "./store-inventory.js";

const RULE_ID = "pinia/state/no-store-destructure";

export const noStoreDestructure = createRule({
  meta: {
    id: RULE_ID,
    title: "Destructure store state and getters through storeToRefs()",
    description:
      "Report state and getters destructured straight from a Pinia store during setup, which copies their current values.",
    why: "A Pinia store is a reactive() object, and Pinia's docs say it cannot be destructured: like props, reading a state property or getter into a local copies its current value. The local never changes when the store does, so templates, computed values, and watchers that read it go stale. Actions are bound to the store and can be destructured.",
    recommendedReplacement:
      "Destructure state and getters from storeToRefs(store), which returns a ref for each of them, and keep destructuring actions from the store itself. Or read store.key where the value is used.",
    examples: [
      {
        title: "Extract state and getters with storeToRefs()",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nconst store = useCounterStore()\nconst { count, doubleCount, increment } = store\n</script>',
        valid:
          "<script setup lang=\"ts\">\nimport { storeToRefs } from 'pinia'\n\nconst store = useCounterStore()\nconst { count, doubleCount } = storeToRefs(store)\nconst { increment } = store\n</script>",
      },
    ],
    category: "state",
    severity: "warn",
    confidence: "heuristic-high",
    fixable: false,
    diagnosticCodes: ["PINIA0005"],
    docsUrl: "https://pinia.vuejs.org/core-concepts/#Destructuring-from-a-Store",
    execution: "workspace",
    cacheScope: "none",
    requires: { crossFile: true },
    requiresContext: ["cross-file"],
    consumesEvidence: ["ast", "graph"],
    cost: "medium",
  },
  create(ctx) {
    return {
      async onWorkspaceEnd() {
        const collection = await collectStores(ctx);
        if (!collection.stores.length) return;
        const gaps = new Map<CollectedStore, Set<string>>();
        for (const call of await findStoreCalls(ctx, collection)) {
          for (const pattern of destructuredStore(call)) {
            if (call.contextOf(pattern) !== "setup") continue;
            const { inventory } = call.store;
            const copied: string[] = [];
            for (const property of pattern.properties) {
              const key = property.type === "Property" ? ownPropertyName(property) : null;
              if (key === null) continue;
              const kind = inventory.keys.get(key)?.kind;
              if (kind === "state" || kind === "getter") copied.push(key);
              else if (!kind && inventory.gap) {
                const files = gaps.get(call.store) ?? new Set();
                files.add(call.file);
                gaps.set(call.store, files);
              }
            }
            if (copied.length) report(ctx, call, pattern, copied);
          }
        }
        for (const [store, files] of gaps) {
          ctx.project.evidenceGaps = [
            ...(ctx.project.evidenceGaps ?? []),
            {
              source: "vite-doctor/pinia",
              message: `${RULE_ID} could not tell whether keys destructured from store "${store.located.store.id}" are state or actions: ${store.inventory.gap}.`,
              files: [store.located.module.file, ...files].map((file) =>
                relative(ctx.project.root, file),
              ),
            },
          ];
        }
      },
    };
  },
});

/**
 * Object patterns that receive the store itself: `const { a } = useXStore()`, or a pattern
 * destructuring a const binding of the store.
 */
function destructuredStore(call: StoreCall): AnyNode[] {
  const patterns: AnyNode[] = [];
  const { expression, parent } = enclosing(call.call, call.parents);
  const pattern = objectPattern(expression, parent);
  if (pattern) return [pattern];
  if (
    parent?.type !== "VariableDeclarator" ||
    parent.init !== expression ||
    parent.id?.type !== "Identifier" ||
    call.parents.get(parent)?.kind !== "const"
  )
    return patterns;
  const [variable] = call.source.scope.scopeManager.getDeclaredVariables(parent);
  for (const reference of variable?.references ?? []) {
    if (reference.init || !reference.isRead()) continue;
    const use = enclosing(reference.identifier, call.parents);
    const found = objectPattern(use.expression, use.parent);
    if (found) patterns.push(found);
  }
  return patterns;
}

function objectPattern(expression: AnyNode, parent: AnyNode): AnyNode {
  if (
    parent?.type === "VariableDeclarator" &&
    parent.init === expression &&
    parent.id?.type === "ObjectPattern"
  )
    return parent.id;
  if (
    parent?.type === "AssignmentExpression" &&
    parent.right === expression &&
    parent.left?.type === "ObjectPattern"
  )
    return parent.left;
  return undefined;
}

function report(ctx: RuleContext, call: StoreCall, pattern: AnyNode, keys: string[]) {
  const { located, inventory } = call.store;
  const id = located.store.id;
  const definition = relative(ctx.project.root, located.module.file);
  const list = keys.map((key) => `"${key}" (${inventory.keys.get(key)!.kind})`).join(", ");
  const actions = pattern.properties.flatMap((property: AnyNode) => {
    const key = property.type === "Property" ? ownPropertyName(property) : null;
    return key !== null && inventory.keys.get(key)?.kind === "action" ? [key] : [];
  });
  const byName = call.byName
    ? ` Doctor found no import of the store here, so it matched the call to the only store exported under that name, as an auto-import from @pinia/nuxt or unplugin-auto-import would resolve it.`
    : "";
  const range = storeRange(ctx, call.file, call.text, pattern);
  ctx.report(
    diagnostics.PINIA0005({
      why: `This destructures ${list} straight from store "${id}" (${definition}). The store is a reactive() object, so each local holds the value it had when setup ran and does not update when the store changes.${byName}`,
      fix: `Destructure ${keys.join(", ")} from storeToRefs(store) (imported from pinia) and read them with .value in script${actions.length ? `; keep destructuring the actions ${actions.join(", ")} from the store` : ""}. Or read store.${keys[0]} where the value is used.`,
    }),
    {
      ruleId: RULE_ID,
      severity: ctx.severity,
      category: "state",
      file: call.file,
      range,
      confidence: call.byName ? "heuristic-medium" : "heuristic-high",
      evidence: [
        {
          kind: "ast",
          file: call.file,
          range,
          summary: `Store "${id}" declares ${list} in ${definition}.`,
        },
      ],
      related: keys.map((key) => ({
        file: located.module.file,
        range: storeRange(
          ctx,
          located.module.file,
          located.module.text,
          inventory.keys.get(key)!.node,
        ),
        message: `Declares ${inventory.keys.get(key)!.kind} "${key}"`,
      })),
    },
  );
}
