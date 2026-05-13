<script setup lang="ts">
const props = defineProps<{
  path: string;
}>();

const { data: rule, pending } = await useRuleContent(() => props.path);
</script>

<template>
  <div>
    <p v-if="pending" class="py-3 text-sm text-neutral-500 dark:text-neutral-500">
      Loading rule details...
    </p>
    <RuleContent v-else-if="rule" :rule="rule" />
    <p v-else class="py-3 text-sm text-neutral-500 dark:text-neutral-500">
      Rule details are not available.
    </p>
  </div>
</template>
