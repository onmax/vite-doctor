<script setup lang="ts">
import { useClipboard } from "@vueuse/core";

const { command } = defineProps<{ command: string }>();

const { copy, copied } = useClipboard({ legacy: true, copiedDuring: 1500 });
</script>

<template>
  <div
    class="flex items-center gap-3 rounded-[0.5rem] border border-neutral-950/10 bg-white py-2.5 pr-2.5 pl-4 font-mono text-sm dark:border-white/10 dark:bg-neutral-900"
  >
    <code class="min-w-0 flex-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none]">
      <slot>{{ command }}</slot>
    </code>
    <button
      type="button"
      :aria-label="copied ? 'Copied command' : 'Copy command'"
      class="inline-flex size-7 shrink-0 items-center justify-center rounded-[0.375rem] text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-100"
      @click="copy(command)"
    >
      <UIcon
        :name="copied ? 'i-lucide-check' : 'i-lucide-copy'"
        class="size-3.5"
        :class="copied ? 'text-emerald-600 dark:text-emerald-400' : ''"
        aria-hidden="true"
      />
    </button>
  </div>
</template>
