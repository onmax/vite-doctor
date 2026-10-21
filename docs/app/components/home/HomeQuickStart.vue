<script setup lang="ts">
const steps = [
  {
    id: "run",
    icon: "i-lucide-scan-line",
    title: "Run it in the project root",
    description:
      "Doctor reads your dependencies, picks the Rule Packs, and resolves the runtime your framework loads.",
    command: "pnpm dlx vite-doctor .",
    notes: [
      "Install dependencies first; Doctor never runs an install.",
      "Add --fix to apply safe fixes and rerun.",
    ],
  },
  {
    id: "agents",
    icon: "i-lucide-bot",
    title: "Give your agent the skill",
    description:
      "Your agent learns when to run Doctor, how to read the agent report, and how to verify a fix.",
    command: "npx skills add https://vite-doctor.onmax.me/",
    notes: [
      "Non-interactive agent runs get the compact agent report.",
      "Pass --format json or sarif for a fixed contract.",
    ],
  },
  {
    id: "ci",
    icon: "i-lucide-git-pull-request",
    title: "Fail CI on new findings",
    description:
      "Check only the lines a pull request changed, and exit with 1 on errors or any warning.",
    command: "pnpm vite-doctor . --since origin/main --max-warnings 0",
    notes: [
      "Exit 1 on blockers, errors, or warnings over the limit.",
      "Use the direct CLI in CI; nuxt doctor can swallow the exit code.",
    ],
  },
] as const;

type StepId = (typeof steps)[number]["id"];

const active = ref<StepId>("run");
const activeStep = computed(() => steps.find((step) => step.id === active.value) ?? steps[0]);
</script>

<template>
  <div class="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
    <div
      role="tablist"
      aria-label="Quick start steps"
      aria-orientation="vertical"
      class="space-y-2"
    >
      <button
        v-for="step in steps"
        :id="`quick-start-tab-${step.id}`"
        :key="step.id"
        type="button"
        role="tab"
        :aria-selected="active === step.id"
        aria-controls="quick-start-panel"
        class="flex w-full gap-4 rounded-[0.75rem] border p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
        :class="
          active === step.id
            ? 'border-neutral-950/10 bg-neutral-100/80 dark:border-white/10 dark:bg-white/[0.04]'
            : 'border-transparent hover:bg-neutral-100/50 dark:hover:bg-white/[0.02]'
        "
        @click="active = step.id"
      >
        <span
          class="inline-flex size-9 shrink-0 items-center justify-center rounded-[0.5rem] bg-neutral-200/70 text-neutral-700 dark:bg-white/10 dark:text-neutral-300"
        >
          <UIcon :name="step.icon" class="size-4" aria-hidden="true" />
        </span>
        <span class="min-w-0">
          <span class="block font-medium text-neutral-950 dark:text-neutral-50">{{
            step.title
          }}</span>
          <span
            class="mt-1 block text-[0.9375rem]/6 text-pretty text-neutral-600 dark:text-neutral-400"
            >{{ step.description }}</span
          >
        </span>
      </button>
    </div>

    <div
      id="quick-start-panel"
      role="tabpanel"
      :aria-labelledby="`quick-start-tab-${activeStep.id}`"
      class="min-w-0 space-y-3"
    >
      <HomeCopyCommand :command="activeStep.command">
        <span class="text-violet-700 dark:text-violet-300">{{
          activeStep.command.split(" ")[0]
        }}</span>
        {{ activeStep.command.split(" ").slice(1).join(" ") }}
      </HomeCopyCommand>
      <div
        class="rounded-[0.5rem] border border-dashed border-neutral-950/10 px-4 py-3 font-mono text-xs/6 text-neutral-500 dark:border-white/10 dark:text-neutral-400"
      >
        <p v-for="note in activeStep.notes" :key="note" class="flex gap-2">
          <span class="select-none text-neutral-300 dark:text-neutral-600" aria-hidden="true"
            >→</span
          >
          <span class="min-w-0">{{ note }}</span>
        </p>
      </div>
    </div>
  </div>
</template>
