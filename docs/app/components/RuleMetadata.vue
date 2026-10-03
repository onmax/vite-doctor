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
  ruleId?: string;
  rulePath?: string;
  diagnosticCodes?: string;
}>();

const codes = computed(() =>
  (props.diagnosticCodes ?? "")
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean),
);
</script>

<template>
  <div class="not-prose border-b border-default pb-6">
    <div class="flex flex-wrap items-center gap-2">
      <ULink
        v-for="code in codes"
        :key="code"
        :to="`/diagnostics/${code}`"
        class="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 font-mono text-xs font-semibold text-primary transition-colors hover:bg-primary/20"
      >
        {{ code }}
      </ULink>
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

    <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm/6">
      <UButton
        v-if="ruleId && rulePath"
        :to="rulePath"
        color="neutral"
        variant="link"
        icon="i-lucide-book-open"
        class="px-0 font-mono"
      >
        {{ ruleId }}
      </UButton>
      <code v-else-if="ruleId" class="font-mono text-sm text-highlighted">{{ ruleId }}</code>
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
