<script setup lang="ts">
const props = defineProps<{
  pack: string;
  category: string;
  severity: "error" | "warn" | "info" | string;
  fix?: string;
  source: string;
  sourceUrl: string;
  docsUrl?: string;
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
  <div class="not-prose mt-4 border-y border-default py-4">
    <div class="flex flex-wrap items-center gap-2">
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
