import { relative } from "pathe";
import { createRule, type RuleContext } from "../../../core/index.js";
import {
  findLocalStateWrites,
  stateCollections,
  type LocalStateWrite,
} from "../../../core/internal/shared-state-writes.js";
import { diagnostics } from "../diagnostics.js";
import {
  collectStores,
  enclosing,
  readProperties,
  setupReturn,
  stateFactory,
  storeRange,
  unwrap,
  vueApiCall,
  walk,
  type AnyNode,
  type CollectedStore,
} from "./store-inventory.js";

const RULE_ID = "pinia/stores/no-unreturned-setup-state";
const MAX_LISTED_WRITES = 3;

export const noUnreturnedSetupState = createRule({
  meta: {
    id: RULE_ID,
    title: "Return every ref and reactive() a setup store changes",
    description:
      "Report ref() and reactive() state that a setup store's functions write but its setup function does not return.",
    why: "Pinia builds a setup store's state from the refs and reactive objects the setup function returns, and its docs say you must return all state properties. State left out is missing from store.$state, $patch(), $reset() in plugins, Devtools, and the payload that hydrates the store after server-side rendering, so the client starts from the initial value and anything computed from it can differ from the server.",
    recommendedReplacement:
      "Add the ref or reactive object to the object the setup function returns. If it should not be state, use a plain variable instead of ref() or reactive().",
    examples: [
      {
        title: "Return the state the actions write",
        language: "ts",
        invalid:
          "export const useSearchStore = defineStore('search', () => {\n  const query = ref('')\n  const results = computed(() => search(query.value))\n  function setQuery(value: string) {\n    query.value = value\n  }\n  return { results, setQuery }\n})",
        valid:
          "export const useSearchStore = defineStore('search', () => {\n  const query = ref('')\n  const results = computed(() => search(query.value))\n  function setQuery(value: string) {\n    query.value = value\n  }\n  return { query, results, setQuery }\n})",
      },
    ],
    category: "stores",
    severity: "warn",
    confidence: "heuristic-high",
    fixable: false,
    diagnosticCodes: ["PINIA0007"],
    docsUrl: "https://pinia.vuejs.org/core-concepts/#Setup-Stores",
    execution: "workspace",
    cacheScope: "none",
    requires: { crossFile: true },
    requiresContext: ["cross-file"],
    consumesEvidence: ["ast"],
    cost: "small",
  },
  create(ctx) {
    return {
      async onWorkspaceEnd() {
        const collection = await collectStores(ctx);
        for (const store of collection.stores) {
          if (store.inventory.kind !== "setup") continue;
          const setup = unwrap(store.call.arguments[1]);
          if (setup?.body?.type !== "BlockStatement") continue;
          const candidates = unreturnedCandidates(ctx, store, setup);
          if (!candidates.length) continue;
          const returned = setupReturn(store.scope, setup);
          if (!returned || !readProperties(returned).complete) {
            ctx.project.evidenceGaps = [
              ...(ctx.project.evidenceGaps ?? []),
              {
                source: "vite-doctor/pinia",
                message: `${RULE_ID} could not read every key the setup function of store "${store.located.store.id}" returns, so it did not check whether ${candidates.map((item) => item.name).join(", ")} ${candidates.length === 1 ? "is" : "are"} returned.`,
                files: [relative(ctx.project.root, store.located.module.file)],
              },
            ];
            continue;
          }
          for (const candidate of candidates) {
            if (candidate.references.some((node: AnyNode) => contains(returned, node))) continue;
            report(ctx, store, candidate);
          }
        }
      },
    };
  },
});

interface Candidate {
  name: string;
  declaration: AnyNode;
  shape: "ref" | "reactive";
  references: AnyNode[];
  writes: LocalStateWrite[];
}

/**
 * Top-level `const x = ref()` or `reactive()` declarations of the setup function that a nested
 * function writes, and that are only used through `.value` or property access, so they cannot reach
 * the returned object through another binding.
 */
function unreturnedCandidates(
  ctx: RuleContext,
  store: CollectedStore,
  setup: AnyNode,
): Candidate[] {
  const { scope } = store;
  const { file, text } = store.located.module;
  const parents = new WeakMap<AnyNode, AnyNode>();
  walk(scope, setup, (node, ancestors) => {
    if (ancestors.length) parents.set(node, ancestors.at(-1));
  });
  const candidates: Candidate[] = [];
  for (const statement of setup.body.body) {
    if (statement.type !== "VariableDeclaration" || statement.kind !== "const") continue;
    for (const declarator of statement.declarations) {
      if (declarator.id?.type !== "Identifier") continue;
      const init = unwrap(declarator.init);
      const shape = stateFactory(ctx, file, scope, init);
      if (!shape) continue;
      const [variable] = scope.scopeManager.getDeclaredVariables(declarator);
      if (!variable) continue;
      const references = variable.references
        .filter((reference) => !reference.init)
        .map((reference) => reference.identifier);
      if (!references.every((node) => containedUse(ctx, store, node, parents))) continue;
      const writes = findLocalStateWrites(
        ctx,
        file,
        text,
        scope,
        variable,
        shape,
        stateCollections(scope, init.arguments[0]),
      ).filter((write) => write.enclosingFunction && write.enclosingFunction !== setup);
      if (!writes.length) continue;
      candidates.push({
        name: declarator.id.name,
        declaration: declarator.id,
        shape,
        references,
        writes,
      });
    }
  }
  return candidates;
}

/** `x.value`, `x.key`, or `watch(x, ...)`: uses that read or write the state without aliasing it. */
function containedUse(
  ctx: RuleContext,
  store: CollectedStore,
  node: AnyNode,
  parents: WeakMap<AnyNode, AnyNode>,
): boolean {
  const { expression, parent } = enclosing(node, parents);
  if (parent?.type === "MemberExpression" && parent.object === expression) return true;
  return (
    parent?.type === "CallExpression" &&
    parent.arguments[0] === expression &&
    vueApiCall(ctx, store.located.module.file, store.scope, parent) === "watch"
  );
}

function contains(outer: AnyNode, inner: AnyNode) {
  return inner.range[0] >= outer.range[0] && inner.range[1] <= outer.range[1];
}

function report(ctx: RuleContext, store: CollectedStore, candidate: Candidate) {
  const { file, text } = store.located.module;
  const id = store.located.store.id;
  const range = storeRange(ctx, file, text, candidate.declaration);
  const lines = [...new Set(candidate.writes.map((write) => write.range.line))];
  const shown = lines.slice(0, MAX_LISTED_WRITES).join(", ");
  const more =
    lines.length > MAX_LISTED_WRITES ? `, and ${lines.length - MAX_LISTED_WRITES} more` : "";
  ctx.report(
    diagnostics.PINIA0007({
      why: `Setup store "${id}" writes "${candidate.name}" from a function (line${lines.length === 1 ? "" : "s"} ${shown}${more}) but does not return it, so Pinia does not treat it as state: it is missing from store.$state, $patch(), Devtools, and the state that hydrates the store after server-side rendering.`,
      fix: `Add ${candidate.name} to the object the setup function of store "${id}" returns. If it is not meant to be state, make it a plain variable instead of ${candidate.shape}().`,
    }),
    {
      ruleId: RULE_ID,
      severity: ctx.severity,
      category: "stores",
      file,
      range,
      confidence: "heuristic-high",
      evidence: [
        {
          kind: "ast",
          file,
          range,
          summary: `"${candidate.name}" is declared with ref() or reactive() in the setup function and missing from its return object.`,
        },
      ],
      related: candidate.writes.map((write) => ({
        file,
        range: write.range,
        message: `Writes ${candidate.name}`,
      })),
    },
  );
}
