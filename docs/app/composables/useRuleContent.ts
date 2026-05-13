import type { MaybeRefOrGetter } from "vue";

export function useRuleContent(path: MaybeRefOrGetter<string>) {
  const rulePath = computed(() => toValue(path));

  return useAsyncData(
    () => `rule-content-${rulePath.value}`,
    () => queryCollection("rules").path(rulePath.value).first(),
    { watch: [rulePath] },
  );
}
