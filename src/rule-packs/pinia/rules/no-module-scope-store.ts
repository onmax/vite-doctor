import { relative } from "pathe";
import { createRule } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";
import { nuxtForFile } from "./shared.js";
import { collectStores, findStoreCalls, storeRange } from "./store-inventory.js";

const RULE_ID = "pinia/stores/no-module-scope-store";
// A module that creates or activates Pinia itself, such as a SPA entry or a test setup, can call
// stores at its top level after `app.use(pinia)`.
const PINIA_SETUP = /\b(?:createPinia|setActivePinia|createTestingPinia)\s*\(/;

export const noModuleScopeStore = createRule({
  meta: {
    id: RULE_ID,
    title: "Call stores inside setup or functions, not at module scope",
    description:
      "Report useXStore() calls that run when a module is first imported instead of inside setup, a composable, an action, or a callback.",
    why: 'useXStore() finds its Pinia instance through the current app\'s injection context, falling back to the active Pinia. At module scope there is no app context: before app.use(pinia) runs, Pinia throws "getActivePinia()" was called but there was no active Pinia, and with server-side rendering the module runs once per server process, so every request shares the store it got.',
    recommendedReplacement:
      "Move the useXStore() call into the function that needs the store: <script setup>, setup(), a composable, a store action, a router guard, or a Nuxt plugin or middleware callback.",
    examples: [
      {
        title: "Call the store inside the guard that uses it",
        language: "ts",
        invalid:
          "const user = useUserStore()\n\nrouter.beforeEach((to) => {\n  if (to.meta.requiresAuth && !user.isLoggedIn) return '/login'\n})",
        valid:
          "router.beforeEach((to) => {\n  const user = useUserStore()\n  if (to.meta.requiresAuth && !user.isLoggedIn) return '/login'\n})",
      },
    ],
    category: "stores",
    severity: "warn",
    confidence: "heuristic-high",
    fixable: false,
    diagnosticCodes: ["PINIA0006"],
    docsUrl: "https://pinia.vuejs.org/core-concepts/outside-component-usage.html",
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
        for (const call of await findStoreCalls(ctx, collection)) {
          if (call.context !== "module" || call.call.arguments.length) continue;
          if (PINIA_SETUP.test(call.text)) continue;
          const id = call.store.located.store.id;
          const name = call.call.callee.name ?? "useStore";
          const nuxt = nuxtForFile(ctx, call.file);
          const ssr = Boolean(nuxt) && nuxt?.ssr !== false;
          const byName = call.byName
            ? ` Doctor found no import of the store here, so it matched the call to the only store exported under that name, as an auto-import from @pinia/nuxt or unplugin-auto-import would resolve it.`
            : "";
          const range = storeRange(ctx, call.file, call.text, call.call);
          ctx.report(
            diagnostics.PINIA0006({
              why: `${name}() for store "${id}" runs at module scope, when this module is first imported, outside any component setup or app context. ${ssr ? "With server-side rendering the module runs once per server process, so every request shares the store it got, or Pinia throws because no Pinia is active yet." : 'If the module is imported before app.use(pinia), Pinia throws "getActivePinia()" was called but there was no active Pinia.'}${byName}`,
              fix: `Move ${name}() into the function that uses the store, such as <script setup>, a composable, an action, a router guard, or a plugin or middleware callback.`,
            }),
            {
              ruleId: RULE_ID,
              severity: ctx.severity,
              category: "stores",
              file: call.file,
              range,
              confidence: call.byName ? "heuristic-medium" : "heuristic-high",
              evidence: [
                {
                  kind: "ast",
                  file: call.file,
                  range,
                  summary: `Module-scope call to store "${id}" defined in ${relative(ctx.project.root, call.store.located.module.file)}.`,
                },
              ],
            },
          );
        }
      },
    };
  },
});
