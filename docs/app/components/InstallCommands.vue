<script setup lang="ts">
const commandTabs = [
  {
    label: "For humans",
    value: "humans",
    icon: "i-lucide-user",
  },
  {
    label: "For agents",
    value: "agents",
    icon: "i-lucide-bot",
  },
] as const;

const packageManagers = computed(
  () =>
    [
      {
        label: "pnpm",
        value: "pnpm",
        icon: "i-simple-icons-pnpm",
        doctorCommand: "pnpm dlx vite-doctor .",
      },
      {
        label: "npm",
        value: "npm",
        icon: "i-simple-icons-npm",
        doctorCommand: "npx vite-doctor .",
      },
      {
        label: "bun",
        value: "bun",
        icon: "i-simple-icons-bun",
        doctorCommand: "bunx vite-doctor .",
      },
      {
        label: "yarn",
        value: "yarn",
        icon: "i-simple-icons-yarn",
        doctorCommand: "yarn dlx vite-doctor .",
      },
    ] as const,
);

type PackageManager = (typeof packageManagers.value)[number]["value"];

const activeCommandTab = ref<(typeof commandTabs)[number]["value"]>("humans");
const activePackageManager = ref<PackageManager>("pnpm");
const copied = ref<string | null>(null);
const selectedPackageManager = computed(
  () =>
    packageManagers.value.find((manager) => manager.value === activePackageManager.value) ??
    packageManagers.value[0],
);
const skillsCommand = "npx skills add https://vite-doctor.onmax.me/";
const activeCommand = computed(() =>
  activeCommandTab.value === "humans" ? selectedPackageManager.value.doctorCommand : skillsCommand,
);
const activeCopyKey = computed(() => (activeCommandTab.value === "humans" ? "cmd" : "skills"));
const copyLabel = computed(() =>
  activeCommandTab.value === "humans"
    ? copied.value === activeCopyKey.value
      ? "Copied command"
      : "Copy command"
    : copied.value === activeCopyKey.value
      ? "Copied skills command"
      : "Copy skills command",
);

async function copy(value: string, key: string) {
  let didCopy = false;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      didCopy = true;
    }
  } catch {}

  if (!didCopy) {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    didCopy = document.execCommand("copy");
    textarea.remove();
  }

  copied.value = key;
  setTimeout(() => {
    if (copied.value === key) copied.value = null;
  }, 1500);
}

watch([activePackageManager, activeCommandTab], () => {
  copied.value = null;
});
</script>

<template>
  <div class="flex w-full max-w-full flex-col items-stretch gap-3">
    <div class="flex w-full flex-wrap items-center justify-between gap-3">
      <div
        class="relative inline-grid grid-cols-2 gap-1 rounded-full bg-neutral-100/80 p-1 text-sm ring-1 ring-neutral-200/80 dark:bg-neutral-900/80 dark:ring-white/10"
        role="tablist"
        aria-label="Command audience"
      >
        <span
          class="pointer-events-none absolute top-1 bottom-1 left-1 w-[calc((100%_-_0.75rem)/2)] rounded-full bg-white shadow-sm ring-1 ring-black/5 transition-transform duration-[400ms] ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none dark:bg-neutral-800 dark:ring-white/10"
          :style="{
            transform:
              activeCommandTab === 'agents' ? 'translateX(calc(100% + 0.25rem))' : 'translateX(0)',
          }"
          aria-hidden="true"
        />
        <button
          v-for="tab in commandTabs"
          :key="tab.value"
          type="button"
          role="tab"
          :aria-selected="activeCommandTab === tab.value"
          class="relative z-10 inline-flex min-w-32 items-center justify-center gap-1.5 rounded-full px-3 py-1.5 font-medium transition-[color,transform] duration-150 active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
          :class="
            activeCommandTab === tab.value
              ? 'text-neutral-950 dark:text-neutral-50'
              : 'text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100'
          "
          @click="activeCommandTab = tab.value"
        >
          <UIcon :name="tab.icon" class="size-3.5 shrink-0" aria-hidden="true" />
          <span>{{ tab.label }}</span>
        </button>
      </div>

      <div
        class="relative h-10 shrink-0 md:ml-auto md:w-[12rem]"
        role="radiogroup"
        aria-label="Package manager"
        :aria-hidden="activeCommandTab !== 'humans'"
      >
        <div
          class="absolute top-0 right-0 flex items-center gap-1 rounded-full bg-neutral-100/80 p-1 text-sm ring-1 ring-neutral-200/80 transition-[opacity,transform,filter] duration-[260ms] ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none dark:bg-neutral-900/80 dark:ring-white/10"
          :class="
            activeCommandTab === 'humans'
              ? 'translate-y-0 opacity-100'
              : 'pointer-events-none translate-y-1 opacity-0 blur-[1px]'
          "
          :aria-hidden="activeCommandTab !== 'humans'"
        >
          <button
            v-for="manager in packageManagers"
            :key="manager.value"
            type="button"
            role="radio"
            :tabindex="activeCommandTab === 'humans' ? 0 : -1"
            :aria-checked="activePackageManager === manager.value"
            :aria-label="manager.label"
            class="inline-flex h-8 min-w-8 items-center justify-center overflow-hidden rounded-full font-medium transition-[width,color,transform,background-color,box-shadow] duration-[220ms] ease-out active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 motion-reduce:transition-none"
            :class="
              activePackageManager === manager.value
                ? 'w-22 bg-white px-2.5 text-neutral-950 shadow-sm ring-1 ring-black/5 dark:bg-neutral-800 dark:text-neutral-50 dark:ring-white/10'
                : 'w-8 px-0 text-neutral-500 grayscale hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100'
            "
            @click="activePackageManager = manager.value"
          >
            <UIcon :name="manager.icon" class="size-3.5 shrink-0" aria-hidden="true" />
            <span
              class="overflow-hidden whitespace-nowrap transition-[max-width,opacity,margin-left] duration-[180ms] ease-out motion-reduce:transition-none"
              :class="
                activePackageManager === manager.value
                  ? 'ml-1.5 max-w-12 opacity-100'
                  : 'ml-0 max-w-0 opacity-0'
              "
            >
              {{ manager.label }}
            </span>
          </button>
        </div>
      </div>
    </div>

    <UButton
      type="button"
      color="neutral"
      variant="ghost"
      :aria-label="copyLabel"
      class="group inline-flex w-full max-w-xl items-center gap-1.5 rounded-full bg-white px-2.5 py-1.5 text-left shadow-sm ring-1 ring-neutral-200 transition-[box-shadow,background-color] duration-200 hover:bg-white hover:ring-neutral-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 dark:bg-neutral-950 dark:ring-white/10 dark:hover:bg-neutral-950 dark:hover:ring-white/20"
      @click="copy(activeCommand, activeCopyKey)"
    >
      <span class="font-mono text-base text-neutral-300 select-none" aria-hidden="true">$</span>
      <span
        class="relative block min-w-0 flex-1 overflow-hidden font-mono text-[0.9375rem] text-neutral-950 dark:text-neutral-100"
      >
        <Transition name="command-swap" mode="out-in">
          <code
            :key="activeCommand"
            class="block overflow-x-auto whitespace-nowrap py-1 [scrollbar-width:thin]"
          >
            {{ activeCommand }}
          </code>
        </Transition>
      </span>
      <span
        class="relative ml-1 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-neutral-900 transition-colors group-hover:bg-neutral-100 dark:text-neutral-100 dark:group-hover:bg-white/10"
      >
        <Transition name="copy-icon" mode="out-in">
          <UIcon
            :key="copied === activeCopyKey ? 'check' : 'copy'"
            :name="copied === activeCopyKey ? 'i-lucide-check' : 'i-lucide-copy'"
            class="size-3.5"
            :class="copied === activeCopyKey ? 'text-emerald-500' : ''"
            aria-hidden="true"
          />
        </Transition>
      </span>
    </UButton>
  </div>
</template>

<style scoped>
.command-swap-enter-active,
.command-swap-leave-active {
  transition:
    opacity 180ms cubic-bezier(0.23, 1, 0.32, 1),
    filter 180ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 180ms cubic-bezier(0.23, 1, 0.32, 1);
}

.command-swap-enter-from,
.command-swap-leave-to {
  opacity: 0;
  filter: blur(1px);
  transform: translateY(2px);
}

.copy-icon-enter-active,
.copy-icon-leave-active {
  transition:
    opacity 200ms cubic-bezier(0.23, 1, 0.32, 1),
    filter 200ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 200ms cubic-bezier(0.23, 1, 0.32, 1);
}

.copy-icon-enter-from,
.copy-icon-leave-to {
  opacity: 0;
  filter: blur(1px);
  transform: scale(0.5);
}

@media (prefers-reduced-motion: reduce) {
  .command-swap-enter-active,
  .command-swap-leave-active,
  .copy-icon-enter-active,
  .copy-icon-leave-active {
    transition-duration: 0ms;
  }
}
</style>
