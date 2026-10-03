<script setup lang="ts">
import { appendRulesNavigation } from "../../utils/rules-navigation";

defineProps<{
  trailingIcon?: string;
  ui?: Record<string, unknown>;
}>();

const { sidebarNavigation } = useSubNavigation();
const { navigation: rulesNavigation, groupKey, ready } = useRulesNavigation();
await ready;

const navigation = computed(() =>
  appendRulesNavigation(sidebarNavigation.value || [], rulesNavigation.value),
);
</script>

<template>
  <UContentNavigation
    :key="groupKey"
    highlight
    :navigation="navigation"
    :trailing-icon="trailingIcon"
    :ui="ui"
  />
</template>
