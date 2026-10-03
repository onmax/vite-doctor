import { computed } from "vue";
import {
  createRulesNavigation,
  resolveRulesActivePath,
  rulesNavigationGroupKey,
  type DiagnosticNavigationEntry,
  type RuleNavigationEntry,
} from "../utils/rules-navigation.js";

declare const useAsyncData: (...args: any[]) => any;
declare const useRoute: () => { path: string };
declare const queryCollection: (collection: "rules" | "diagnostics") => any;

type NavigationEntries = [RuleNavigationEntry[], DiagnosticNavigationEntry[]];

export function useRulesNavigation(options: { includeDiagnostics?: boolean } = {}) {
  const route = useRoute();
  const asyncData = useAsyncData(
    "rules-navigation-entries",
    (): Promise<NavigationEntries> =>
      Promise.all([
        queryCollection("rules")
          .select("path", "title", "ruleId", "framework", "category", "pack")
          .all(),
        queryCollection("diagnostics").select("code", "ruleId", "path", "framework").all(),
      ]),
  );
  const entries = computed<NavigationEntries>(() => asyncData.data.value ?? [[], []]);
  const activePath = computed(() => resolveRulesActivePath(route.path, ...entries.value));
  const navigation = computed(() =>
    createRulesNavigation(...entries.value, {
      activePath: activePath.value,
      includeDiagnostics: options.includeDiagnostics,
    }),
  );
  const groupKey = computed(() => rulesNavigationGroupKey(activePath.value));

  return { navigation, activePath, groupKey, ready: asyncData as Promise<unknown> };
}
