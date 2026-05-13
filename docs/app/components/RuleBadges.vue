<script setup lang="ts">
import { fixBadgeColor, fixLabel, severityBadgeColor } from "../utils/rule-metadata";

const props = defineProps<{
  pack: string;
  category: string;
  severity: "error" | "warn" | "info" | string;
  fix?: string;
}>();
</script>

<template>
  <div class="my-4 flex flex-wrap items-center gap-2">
    <UBadge color="neutral" variant="soft" class="rounded-md font-mono">
      {{ pack }}
    </UBadge>
    <UBadge color="neutral" variant="soft" class="rounded-md font-mono">
      {{ category }}
    </UBadge>
    <UBadge :color="severityBadgeColor(props.severity)" variant="soft" class="rounded-md font-mono">
      {{ severity }}
    </UBadge>
    <UBadge :color="fixBadgeColor(props.fix)" variant="soft" class="rounded-md font-mono">
      {{ fixLabel(props.fix) }}
    </UBadge>
  </div>
</template>
