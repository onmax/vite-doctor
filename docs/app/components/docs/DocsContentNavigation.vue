<script setup lang="ts">
import { appendRulesNavigation } from "../../utils/rules-navigation";

const props = defineProps<{
  trailingIcon?: string;
  ui?: Record<string, unknown>;
}>();

const { sidebarNavigation } = useSubNavigation();
const { navigation: rulesNavigation, groupKey } = useRulesNavigation();

const navigation = computed(() =>
  appendRulesNavigation(sidebarNavigation.value || [], rulesNavigation.value),
);

// Rules sit three levels deep, so the default 1.25rem indent per level leaves
// too little room for labels in the fixed-width sidebar.
const navigationUi = computed(() => ({
  listWithChildren: "ms-2 border-s border-default",
  ...props.ui,
}));

function linkTooltip(link: { title?: string; pageTitle?: unknown }) {
  return typeof link.pageTitle === "string" && link.pageTitle !== link.title
    ? link.pageTitle
    : undefined;
}
</script>

<template>
  <UContentNavigation
    :key="groupKey"
    highlight
    :navigation="navigation"
    :trailing-icon="trailingIcon"
    :ui="navigationUi"
  >
    <template #link-title="{ link }">
      <span :title="linkTooltip(link)">{{ link.title }}</span>
    </template>
  </UContentNavigation>
</template>
