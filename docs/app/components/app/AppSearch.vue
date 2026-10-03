<script setup lang="ts">
import type { ContentNavigationItem } from "@nuxt/content";
import { appendRulesNavigation, groupSearchNavigation } from "../../utils/rules-navigation";

const props = defineProps<{
  navigation?: ContentNavigationItem[];
}>();

const { forced: forcedColorMode } = useDocusColorMode();

const { data: files } = useLazyAsyncData(
  "search-sections",
  async () => {
    const [docs, rules, diagnostics] = await Promise.all([
      queryCollectionSearchSections("docs"),
      queryCollectionSearchSections("rules"),
      queryCollectionSearchSections("diagnostics"),
    ]);
    const summaries = [...rules, ...diagnostics].filter((section) => section.level <= 2);
    return [...docs, ...summaries];
  },
  { server: false },
);

const { navigation: rulesNavigation } = useRulesNavigation({ includeDiagnostics: true });
const navigation = computed(() =>
  groupSearchNavigation(appendRulesNavigation(props.navigation || [], rulesNavigation.value)),
);
</script>

<template>
  <LazyUContentSearch :files="files" :navigation="navigation" :color-mode="!forcedColorMode" />
</template>
