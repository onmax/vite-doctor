import { computed, toValue, type MaybeRefOrGetter } from "vue";

declare const useAsyncData: (...args: any[]) => any;
declare const queryCollection: (collection: "rules") => any;

export function useRuleContent(path: MaybeRefOrGetter<string>) {
  const rulePath = computed(() => toValue(path));

  return useAsyncData(
    () => `rule-content-${rulePath.value}`,
    () => queryCollection("rules").path(rulePath.value).first(),
    { watch: [rulePath] },
  );
}
