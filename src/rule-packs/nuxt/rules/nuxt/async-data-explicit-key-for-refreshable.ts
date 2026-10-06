import type { RuleContext } from "../../../../core/index.js";
import { AnyNode, createRule, report, walkScriptLocal } from "./shared.js";
import {
  fileMayCallAsyncData,
  getAsyncDataCall,
  getDestructuredAsyncDataCommands,
  hasKeyedRefreshNuxtDataCall,
  hasObjectProperty,
} from "./async-data.js";

export const asyncDataExplicitKeyForRefreshable = createRule({
  meta: {
    id: "nuxt/async-data-explicit-key-for-refreshable",
    title: "Use explicit keys for refreshable async data",
    category: "fetching",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/api/composables/use-async-data#params",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!fileMayCallAsyncData(ctx)) return;
    let onlyRefreshableEntryForKeyedRefresh: boolean | undefined;
    return {
      CallExpression(node: AnyNode) {
        const call = getAsyncDataCall(ctx, node);
        if (!call || call.hasExplicitKey) return;
        const hasLocalRefresh = getDestructuredAsyncDataCommands(node).has("refresh");
        const hasWatch = hasObjectProperty(call.options, "watch");
        if (!hasLocalRefresh && !hasWatch) {
          onlyRefreshableEntryForKeyedRefresh ??=
            hasKeyedRefreshNuxtDataCall(ctx) && countAsyncDataCalls(ctx) === 1;
          if (!onlyRefreshableEntryForKeyedRefresh) return;
        }
        report(
          ctx,
          node,
          "nuxt/async-data-explicit-key-for-refreshable",
          "warn",
          "fetching",
          "Refreshable async data should use an explicit stable key.",
          "Pass a reviewable key to useAsyncData(), or set the key option on useFetch().",
        );
      },
    };
  },
});

function countAsyncDataCalls(ctx: RuleContext): number {
  let count = 0;
  walkScriptLocal(ctx.file.scriptAst, (node: AnyNode) => {
    if (getAsyncDataCall(ctx, node)) count += 1;
  });
  return count;
}
