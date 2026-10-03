<script setup lang="ts">
defineProps<{
  cwd: string;
  title?: string;
}>();
</script>

<template>
  <div
    class="overflow-hidden rounded-lg bg-[#0a0a0a] shadow-lg shadow-neutral-950/15 ring-1 ring-neutral-950/90 dark:shadow-black/30 dark:ring-white/10"
  >
    <div
      class="flex items-center gap-2 border-b border-white/[0.08] bg-white/[0.025] px-4 py-2 text-xs font-medium text-neutral-500 sm:py-2.5"
    >
      <span class="inline-flex size-2 rounded-full bg-[#ff5f57]/80" aria-hidden="true" />
      <span class="inline-flex size-2 rounded-full bg-[#ffbd2e]/80" aria-hidden="true" />
      <span class="inline-flex size-2 rounded-full bg-[#28c840]/80" aria-hidden="true" />
      <span class="ml-2 min-w-0 truncate font-mono text-neutral-500">{{ cwd }}</span>
      <span v-if="title" class="ml-auto hidden font-mono text-neutral-500 sm:inline">
        {{ title }}
      </span>
    </div>
    <div
      class="space-y-3 px-4.5 py-4 font-mono text-[0.75rem]/5 text-neutral-300 sm:px-5 sm:py-5 sm:text-[0.8125rem]/6"
    >
      <slot />
    </div>
  </div>
</template>
