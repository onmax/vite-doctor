import { createRule } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";
import { expectedStoreName, findStoreDefinitions, isConventionalStoreName } from "./shared.js";

export const storeNameMatchesId = createRule({
  meta: {
    id: "pinia/stores/store-name-matches-id",
    title: "Name store composables after their id",
    description:
      "Name the variable that receives defineStore() use<Id>Store, matching the literal store id.",
    why: "Pinia's convention is to name the defineStore() return value use followed by the store id and Store. When the composable name and the id drift apart, Devtools, SSR state keys, and HMR show an id that nobody can find by searching for the composable, and two stores can end up sharing an id unnoticed.",
    recommendedReplacement:
      "Rename the composable to use<Id>Store, or change the id so it describes the store the composable returns. Kebab-case, snake_case, and camelCase ids map to the same PascalCase name, so 'shopping-cart' and 'shoppingCart' both expect useShoppingCartStore.",
    examples: [
      {
        title: "Match the composable name to the store id",
        language: "ts",
        invalid: "export const useBasket = defineStore('cart', () => {\n  /* ... */\n})",
        valid: "export const useCartStore = defineStore('cart', () => {\n  /* ... */\n})",
      },
    ],
    category: "stores",
    severity: "info",
    fixable: false,
    diagnosticCodes: ["PINIA0002"],
    docsUrl: "https://pinia.vuejs.org/core-concepts/#Defining-a-Store",
    requires: { script: true },
    cost: "tiny",
  },
  create(ctx) {
    if (!ctx.file.text.includes("defineStore")) return;
    return {
      Program(node: any) {
        for (const definition of findStoreDefinitions(node, ctx.file.text)) {
          const binding = definition.binding;
          if (!binding || isConventionalStoreName(binding.name, definition.id)) continue;
          const expected = expectedStoreName(definition.id);
          ctx.report(
            diagnostics.PINIA0002({
              why: `Store composable "${binding.name}" is defined with id "${definition.id}", so its name does not follow Pinia's use<Id>Store convention.`,
              fix: `Rename "${binding.name}" to "${expected}" and update its call sites, or change the store id to match the composable.`,
            }),
            {
              ruleId: "pinia/stores/store-name-matches-id",
              severity: ctx.severity,
              category: "stores",
              range: ctx.range(binding.start, binding.end),
              confidence: "proven",
            },
          );
        }
      },
    };
  },
});
