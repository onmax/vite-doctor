<script setup lang="ts">
const props = defineProps<{
  pack: string;
  category: string;
  severity: "error" | "warn" | "info" | string;
  fix?: string;
}>();

const severityColor = computed(() => {
  if (props.severity === "error") return "error";
  if (props.severity === "warn") return "warning";
  return "info";
});

const fixColor = computed(() => {
  if (props.fix === "safe") return "success";
  if (props.fix === "suggestion") return "primary";
  return "neutral";
});
</script>

<template>
  <div class="my-4 flex flex-wrap items-center gap-2">
    <UBadge color="neutral" variant="soft" class="rounded-md font-mono">
      {{ pack }}
    </UBadge>
    <UBadge color="neutral" variant="soft" class="rounded-md font-mono">
      {{ category }}
    </UBadge>
    <UBadge :color="severityColor" variant="soft" class="rounded-md font-mono">
      {{ severity }}
    </UBadge>
    <UBadge :color="fixColor" variant="soft" class="rounded-md font-mono">
      {{ fix || "no fix" }}
    </UBadge>
  </div>
</template>
