import { computed, toValue, type MaybeRefOrGetter } from "vue";

declare const createUseAsyncData: (...args: any[]) => (...args: any[]) => any;
declare const queryCollection: (collection: "rules") => any;

export const useRuleAsyncData = createUseAsyncData();

export function useRuleContent(path: MaybeRefOrGetter<string>) {
  const rulePath = computed(() => toValue(path));

  return useRuleAsyncData(
    () => `rule-content-${rulePath.value}`,
    () => queryCollection("rules").path(rulePath.value).first(),
    { watch: [rulePath] },
  );
}
