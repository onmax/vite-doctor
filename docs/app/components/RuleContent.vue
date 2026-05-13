<script setup lang="ts">
defineProps<{
  rule: unknown;
}>();
</script>

<template>
  <div
    class="rule-content max-w-none text-sm leading-6 text-neutral-700 dark:text-neutral-300 [&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-neutral-900 dark:[&_h2]:text-neutral-100 [&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:text-neutral-900 dark:[&_h3]:text-neutral-100 [&_p]:my-2 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-neutral-950/10 [&_pre]:bg-white [&_pre]:p-3 [&_pre]:text-xs dark:[&_pre]:border-white/10 dark:[&_pre]:bg-neutral-950 [&_code]:font-mono [&_p_code]:rounded [&_p_code]:bg-neutral-950/5 [&_p_code]:px-1 [&_p_code]:py-0.5 [&_p_code]:text-neutral-900 dark:[&_p_code]:bg-white/10 dark:[&_p_code]:text-neutral-100"
  >
    <ContentRenderer v-if="rule" :value="rule" />
  </div>
</template>
