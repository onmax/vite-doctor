<script setup lang="ts">
import type { DoctorRunResult } from "~/composables/useDoctorWc";

const props = defineProps<{
  result: DoctorRunResult;
  framework: "vue" | "nuxt";
  scanTimeLabel?: string;
}>();

const total = computed(() =>
  props.result.summary.blocker + props.result.summary.error + props.result.summary.warn + props.result.summary.info,
);
const duration = computed(() => {
  const ms = props.result.timings?.total ?? props.result.timings?.runDoctor ?? 0;
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
});

const visibleFindings = computed(() => {
  const order: Record<string, number> = { blocker: 0, error: 1, warn: 2, info: 3 };
  return [...props.result.diagnostics]
    .sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9))
    .slice(0, 3)
    .map((d) => ({
      severity: d.severity === "blocker" || d.severity === "error" ? "high" : d.severity === "warn" ? "medium" : "low",
      title: d.ruleId,
      description: d.message,
      location: d.range ? `${d.file}:${d.range.line}:${d.range.column}` : d.file,
    }));
});

const progress = ref(0);
let tweenTimer: ReturnType<typeof setTimeout> | null = null;
function tweenProgress() {
  if (tweenTimer) clearTimeout(tweenTimer);
  const target = props.result.score;
  progress.value = 0;
  const totalMs = 900;
  const stepMs = 24;
  const steps = Math.max(1, Math.round(totalMs / stepMs));
  let i = 0;
  const tick = () => {
    i += 1;
    progress.value = Math.min(target, Math.round((target * i) / steps));
    if (i < steps) tweenTimer = setTimeout(tick, stepMs);
  };
  tick();
}

watch(() => props.result.score, tweenProgress, { immediate: true });
onBeforeUnmount(() => { if (tweenTimer) clearTimeout(tweenTimer); });

const ARC_LENGTH = 157.08;
const dashArray = computed(() => `${(progress.value / 100) * ARC_LENGTH} ${ARC_LENGTH}`);
</script>

<template>
  <section class="overflow-hidden bg-white dark:bg-neutral-900">
    <div class="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-neutral-100 px-6 py-3.5 text-sm dark:border-neutral-800">
      <span class="inline-flex items-center gap-2">
        <span class="inline-block size-1.5 bg-emerald-500" aria-hidden="true" />
        <span class="font-medium text-neutral-900 dark:text-neutral-100">Scan complete</span>
      </span>
      <span class="hidden h-3 w-px bg-neutral-200 sm:inline-block dark:bg-neutral-800" aria-hidden="true" />
      <span class="text-neutral-500 tabular-nums dark:text-neutral-500">{{ scanTimeLabel ?? "just now" }}</span>
      <span class="hidden h-3 w-px bg-neutral-200 sm:inline-block dark:bg-neutral-800" aria-hidden="true" />
      <span class="font-mono text-neutral-500 tabular-nums dark:text-neutral-500">{{ duration }}</span>
    </div>

    <div class="flex flex-col gap-6 px-6 py-7 sm:grid sm:grid-cols-[auto_1fr] sm:items-center sm:gap-8 sm:px-8">
      <div class="flex flex-col items-center">
        <svg viewBox="0 0 130 80" class="w-36 sm:w-40" aria-hidden="true">
          <defs>
            <linearGradient id="gauge-gradient-live" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stop-color="var(--color-rose-500)" />
              <stop offset="55%" stop-color="var(--color-amber-400)" />
              <stop offset="100%" stop-color="var(--color-emerald-500)" />
            </linearGradient>
          </defs>
          <path d="M 15 65 A 50 50 0 0 1 115 65" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="butt" class="text-neutral-200 dark:text-neutral-800" />
          <path v-if="progress > 0" d="M 15 65 A 50 50 0 0 1 115 65" fill="none" stroke="url(#gauge-gradient-live)" stroke-width="9" stroke-linecap="butt" :stroke-dasharray="dashArray" style="transition: stroke-dasharray 60ms linear" />
        </svg>
        <div class="-mt-7 flex items-baseline gap-1">
          <span class="text-4xl font-semibold tabular-nums tracking-tight text-neutral-900 dark:text-neutral-100">{{ progress }}</span>
          <span class="text-sm text-neutral-500 tabular-nums">/ 100</span>
        </div>
      </div>

      <div class="border-t border-neutral-100 pt-6 sm:border-t-0 sm:border-l sm:pt-0 sm:pl-8 dark:border-neutral-800">
        <div class="flex items-baseline gap-2">
          <span class="text-4xl font-semibold tabular-nums tracking-tight text-neutral-900 dark:text-neutral-100">{{ total }}</span>
          <span class="text-base font-medium text-neutral-700 dark:text-neutral-300">issues found</span>
        </div>
        <p class="mt-1 text-sm text-neutral-500 tabular-nums dark:text-neutral-500">
          {{ framework === "nuxt" ? "Nuxt" : "Vue" }} Doctor &middot; {{ result.diagnostics.length }} diagnostics
        </p>
      </div>
    </div>

    <div class="border-t border-neutral-100 px-6 pt-4 sm:px-8 dark:border-neutral-800">
      <div class="hidden gap-4 pb-3 text-[0.6875rem] font-medium uppercase tracking-wider text-neutral-500 sm:grid sm:grid-cols-[100px_1fr_220px_auto] dark:text-neutral-500">
        <span>Severity</span><span>Rule</span><span>Location</span><span class="sr-only">Action</span>
      </div>
      <ul role="list">
        <li v-for="(f, i) in visibleFindings" :key="`${f.location}-${i}`" class="flex flex-col gap-2 border-t border-neutral-100 py-4 sm:grid sm:grid-cols-[100px_minmax(0,1fr)_220px_auto] sm:items-start sm:gap-4 dark:border-neutral-800">
          <span class="inline-flex items-center gap-2">
            <span class="inline-block size-1.5 shrink-0" :class="{ 'bg-rose-500': f.severity === 'high', 'bg-amber-500': f.severity === 'medium', 'bg-sky-500': f.severity === 'low' }" aria-hidden="true" />
            <span class="text-sm font-medium capitalize" :class="{ 'text-rose-700 dark:text-rose-300': f.severity === 'high', 'text-amber-700 dark:text-amber-300': f.severity === 'medium', 'text-sky-700 dark:text-sky-300': f.severity === 'low' }">{{ f.severity }}</span>
          </span>
          <div class="min-w-0">
            <p class="text-sm font-medium text-neutral-900 dark:text-neutral-100">{{ f.title }}</p>
            <p class="mt-0.5 text-sm text-neutral-500 text-pretty dark:text-neutral-500">{{ f.description }}</p>
          </div>
          <code class="truncate font-mono text-xs text-neutral-500 sm:self-center sm:text-[0.8125rem] dark:text-neutral-500" :title="f.location">{{ f.location }}</code>
          <UIcon name="i-lucide-arrow-up-right" class="hidden size-4 self-center text-neutral-300 sm:inline-block dark:text-neutral-700" aria-hidden="true" />
        </li>
      </ul>
    </div>
  </section>
</template>
