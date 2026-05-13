<script setup lang="ts">
import { fixBadgeColor, fixLabel, severityBadgeColor } from "../utils/rule-metadata";

const props = defineProps<{
  pack: string;
  category: string;
  severity: "error" | "warn" | "info" | string;
  fix?: string;
  source: string;
  sourceUrl: string;
  docsUrl?: string;
}>();
</script>

<template>
  <div class="not-prose mt-4 border-y border-default py-4">
    <div class="flex flex-wrap items-center gap-2">
      <UBadge color="neutral" variant="soft" class="rounded-md font-mono">
        {{ pack }}
      </UBadge>
      <UBadge color="neutral" variant="soft" class="rounded-md font-mono">
        {{ category }}
      </UBadge>
      <UBadge
        :color="severityBadgeColor(props.severity)"
        variant="soft"
        class="rounded-md font-mono"
      >
        {{ severity }}
      </UBadge>
      <UBadge :color="fixBadgeColor(props.fix)" variant="soft" class="rounded-md font-mono">
        {{ fixLabel(props.fix) }}
      </UBadge>
    </div>

    <div class="mt-3 flex flex-wrap items-center gap-3 text-sm/6">
      <UButton
        :to="sourceUrl"
        target="_blank"
        color="neutral"
        variant="link"
        icon="i-simple-icons-github"
        class="px-0 font-mono"
      >
        {{ source }}
      </UButton>
      <UButton
        v-if="docsUrl"
        :to="docsUrl"
        target="_blank"
        color="neutral"
        variant="link"
        icon="i-lucide-book-open"
        class="px-0"
      >
        Upstream docs
      </UButton>
    </div>
  </div>
</template>
