<script setup lang="ts">
import { appendRulesNavigation, createRulesNavigation } from "../../utils/rules-navigation";

defineProps<{
  trailingIcon?: string;
  ui?: Record<string, unknown>;
}>();

const { sidebarNavigation } = useSubNavigation();
const { data: rules } = await useAsyncData("rules-sidebar-navigation-v2", () =>
  Promise.all([
    queryCollection("rules").select("path", "title", "ruleId", "framework", "category").all(),
    queryCollection("diagnostics").select("code", "ruleId").all(),
  ]),
);

const rulesNavigation = computed(() => {
  const [ruleItems = [], diagnosticItems = []] = rules.value || [];
  return createRulesNavigation(ruleItems, diagnosticItems);
});
const navigation = computed(() =>
  appendRulesNavigation(sidebarNavigation.value || [], rulesNavigation.value),
);
</script>

<template>
  <UContentNavigation
    highlight
    default-open
    :navigation="navigation"
    :trailing-icon="trailingIcon"
    :ui="ui"
  />
</template>
