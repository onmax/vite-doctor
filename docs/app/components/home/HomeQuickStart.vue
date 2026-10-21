<script setup lang="ts">
const packageManagers = [
  { id: "pnpm", label: "pnpm", icon: "i-simple-icons-pnpm", dlx: "pnpm dlx", exec: "pnpm" },
  { id: "npm", label: "npm", icon: "i-simple-icons-npm", dlx: "npx", exec: "npx" },
  { id: "bun", label: "bun", icon: "i-simple-icons-bun", dlx: "bunx", exec: "bunx" },
  { id: "yarn", label: "yarn", icon: "i-simple-icons-yarn", dlx: "yarn dlx", exec: "yarn" },
] as const;

type PackageManager = (typeof packageManagers)[number];

type Step = {
  id: string;
  icon: string;
  title: string;
  description: string;
  command: string | ((pm: PackageManager) => string);
  notes: string[];
};

type Audience = {
  id: "humans" | "agents";
  label: string;
  icon: string;
  steps: Step[];
};

const audiences: Audience[] = [
  {
    id: "humans",
    label: "For humans",
    icon: "i-lucide-user",
    steps: [
      {
        id: "run",
        icon: "i-lucide-scan-line",
        title: "Run it in the project root",
        description:
          "Doctor reads your dependencies, picks the Rule Packs, and resolves the runtime your framework loads.",
        command: (pm) => `${pm.dlx} vite-doctor .`,
        notes: [
          "Install dependencies first; Doctor never runs an install.",
          "Nuxt projects can also run nuxt doctor through the module.",
        ],
      },
      {
        id: "fix",
        icon: "i-lucide-wand-sparkles",
        title: "Apply the safe fixes",
        description:
          "Doctor applies safe fixes atomically, runs again, and reports what is left to fix by hand.",
        command: (pm) => `${pm.dlx} vite-doctor . --fix`,
        notes: ["The final report counts applied and skipped edits."],
      },
      {
        id: "ci",
        icon: "i-lucide-git-pull-request",
        title: "Fail CI on new findings",
        description:
          "Check only the lines a pull request changed, and exit with 1 on errors or any warning.",
        command: (pm) => `${pm.exec} vite-doctor . --since origin/main --max-warnings 0`,
        notes: [
          "Exit 1 on blockers, errors, or warnings over the limit.",
          "Use the direct CLI in CI; nuxt doctor can swallow the exit code.",
        ],
      },
    ],
  },
  {
    id: "agents",
    label: "For agents",
    icon: "i-lucide-bot",
    steps: [
      {
        id: "skill",
        icon: "i-lucide-book-open",
        title: "Give your agent the skill",
        description:
          "Your agent learns when to run Doctor, how to read the agent report, and how to verify a fix.",
        command: "npx skills add https://vite-doctor.onmax.me/",
        notes: ["Reads vite-doctor.onmax.me/.well-known/skills/doctor/SKILL.md."],
      },
      {
        id: "report",
        icon: "i-lucide-bot",
        title: "Read the agent report",
        description:
          "Each Diagnostic comes with its location, remediation, confidence, and docs link, without duplicate fields.",
        command: (pm) => `${pm.dlx} vite-doctor . --format agent`,
        notes: [
          "Non-interactive agent runs get this format without the flag.",
          "Use --format json for the full machine report.",
        ],
      },
      {
        id: "verify",
        icon: "i-lucide-circle-check",
        title: "Verify the fix",
        description:
          "After an edit, the agent reruns only the Rule it touched, then the full Doctor Run.",
        command: (pm) =>
          `${pm.dlx} vite-doctor . --rules nuxt/hydration/no-browser-global-in-universal-code --format agent`,
        notes: [
          "The report's commands.verify and commands.rerun hold these templates; commandArgs runs them without a shell.",
        ],
      },
    ],
  },
];

type AudienceId = Audience["id"];

const audienceId = ref<AudienceId>("humans");
const audience = computed(
  () => audiences.find((item) => item.id === audienceId.value) ?? audiences[0]!,
);
const activeStepId = ref("run");
const activeStep = computed(
  () =>
    audience.value.steps.find((step) => step.id === activeStepId.value) ?? audience.value.steps[0]!,
);

const packageManagerId = ref<PackageManager["id"]>("pnpm");
const packageManager = computed(
  () => packageManagers.find((pm) => pm.id === packageManagerId.value) ?? packageManagers[0],
);
const activeCommand = computed(() => {
  const { command } = activeStep.value;
  return typeof command === "string" ? command : command(packageManager.value);
});

function selectAudience(id: AudienceId) {
  audienceId.value = id;
  activeStepId.value = audience.value.steps[0]!.id;
}
</script>

<template>
  <div class="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
    <div class="min-w-0">
      <div role="tablist" aria-label="Audience" class="mb-4 flex gap-1">
        <button
          v-for="item in audiences"
          :key="item.id"
          type="button"
          role="tab"
          :aria-selected="audienceId === item.id"
          aria-controls="quick-start-steps"
          class="inline-flex items-center gap-1.5 rounded-[0.375rem] px-3 py-1.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
          :class="
            audienceId === item.id
              ? 'bg-neutral-200/80 text-neutral-950 dark:bg-white/10 dark:text-neutral-50'
              : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-950 dark:text-neutral-400 dark:hover:bg-white/5 dark:hover:text-neutral-100'
          "
          @click="selectAudience(item.id)"
        >
          <UIcon :name="item.icon" class="size-3.5 shrink-0" aria-hidden="true" />
          {{ item.label }}
        </button>
      </div>

      <div
        id="quick-start-steps"
        role="tablist"
        :aria-label="`Quick start steps ${audience.label.toLowerCase()}`"
        aria-orientation="vertical"
        class="space-y-2"
      >
        <button
          v-for="step in audience.steps"
          :id="`quick-start-tab-${step.id}`"
          :key="step.id"
          type="button"
          role="tab"
          :aria-selected="activeStep.id === step.id"
          aria-controls="quick-start-panel"
          class="flex w-full gap-4 rounded-[0.75rem] border p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
          :class="
            activeStep.id === step.id
              ? 'border-neutral-950/10 bg-neutral-100/80 dark:border-white/10 dark:bg-white/[0.04]'
              : 'border-transparent hover:bg-neutral-100/50 dark:hover:bg-white/[0.02]'
          "
          @click="activeStepId = step.id"
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
    </div>

    <div
      id="quick-start-panel"
      role="tabpanel"
      :aria-labelledby="`quick-start-tab-${activeStep.id}`"
      class="min-w-0 space-y-3"
    >
      <div
        role="radiogroup"
        aria-label="Package manager"
        class="flex gap-1 transition-opacity"
        :class="typeof activeStep.command === 'string' ? 'pointer-events-none opacity-0' : ''"
        :aria-hidden="typeof activeStep.command === 'string'"
      >
        <button
          v-for="pm in packageManagers"
          :key="pm.id"
          type="button"
          role="radio"
          :aria-checked="packageManagerId === pm.id"
          :tabindex="typeof activeStep.command === 'string' ? -1 : 0"
          class="inline-flex items-center gap-1.5 rounded-[0.375rem] px-2.5 py-1 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
          :class="
            packageManagerId === pm.id
              ? 'bg-neutral-200/80 text-neutral-950 dark:bg-white/10 dark:text-neutral-50'
              : 'text-neutral-500 hover:text-neutral-950 dark:text-neutral-400 dark:hover:text-neutral-100'
          "
          @click="packageManagerId = pm.id"
        >
          <UIcon :name="pm.icon" class="size-3.5 shrink-0" aria-hidden="true" />
          {{ pm.label }}
        </button>
      </div>
      <HomeCopyCommand :command="activeCommand">
        <span class="text-violet-700 dark:text-violet-300">{{ activeCommand.split(" ")[0] }}</span>
        {{ activeCommand.split(" ").slice(1).join(" ") }}
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
