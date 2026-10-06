import { computed } from "vue";
import { diagnostics, rules } from "#build/rules-navigation-entries.mjs";
import {
  createRulesNavigation,
  resolveRulesActivePath,
  rulesNavigationGroupKey,
  type RulesNavigationOptions,
} from "../utils/rules-navigation.js";

declare const useRoute: () => { path: string };

export function useRulesNavigation(
  options: Pick<RulesNavigationOptions, "includeDiagnostics" | "ruleTitles"> = {},
) {
  const route = useRoute();
  const activePath = computed(() => resolveRulesActivePath(route.path, rules, diagnostics));
  const navigation = computed(() =>
    createRulesNavigation(rules, diagnostics, {
      activePath: activePath.value,
      includeDiagnostics: options.includeDiagnostics,
      ruleTitles: options.ruleTitles,
    }),
  );
  const groupKey = computed(() => rulesNavigationGroupKey(activePath.value));

  return { navigation, activePath, groupKey };
}
