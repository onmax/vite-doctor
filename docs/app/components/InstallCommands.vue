<script setup lang="ts">
import type { Framework } from "../utils/rule-metadata";

const props = withDefaults(
  defineProps<{
    framework?: Framework | "all";
  }>(),
  {
    framework: "all",
  },
);

const requestURL = useRequestURL();
const mcpEndpoint = computed(() => `${requestURL.origin}/mcp`);

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
        doctorCommand: "pnpm dlx vite-doctor@alpha .",
        agentCommand: `pnpm dlx add-mcp ${mcpEndpoint.value}`,
        nuxtModuleCommand: "pnpm dlx nuxt module add vite-doctor@alpha/nuxt",
      },
      {
        label: "npm",
        value: "npm",
        icon: "i-simple-icons-npm",
        doctorCommand: "npx vite-doctor@alpha .",
        agentCommand: `npx add-mcp ${mcpEndpoint.value}`,
        nuxtModuleCommand: "npx nuxt module add vite-doctor@alpha/nuxt",
      },
      {
        label: "bun",
        value: "bun",
        icon: "i-simple-icons-bun",
        doctorCommand: "bunx vite-doctor@alpha .",
        agentCommand: `bunx add-mcp ${mcpEndpoint.value}`,
        nuxtModuleCommand: "bunx nuxt module add vite-doctor@alpha/nuxt",
      },
      {
        label: "yarn",
        value: "yarn",
        icon: "i-simple-icons-yarn",
        doctorCommand: "yarn dlx vite-doctor@alpha .",
        agentCommand: `yarn dlx add-mcp ${mcpEndpoint.value}`,
        nuxtModuleCommand: "yarn dlx nuxt module add vite-doctor@alpha/nuxt",
      },
    ] as const,
);

type PackageManager = (typeof packageManagers.value)[number]["value"];

const activeCommandTab = ref<(typeof commandTabs)[number]["value"]>("humans");
const activePackageManager = ref<PackageManager>("pnpm");
const copied = ref<string | null>(null);
const commandMeasure = ref<HTMLElement | null>(null);
const commandWidth = ref<number | null>(null);
const showNuxtModule = computed(() => props.framework === "all" || props.framework === "nuxt");
const selectedPackageManager = computed(
  () =>
    packageManagers.value.find((manager) => manager.value === activePackageManager.value) ??
    packageManagers.value[0],
);
const activeCommand = computed(() =>
  activeCommandTab.value === "humans"
    ? selectedPackageManager.value.doctorCommand
    : selectedPackageManager.value.agentCommand,
);
const nuxtModuleCommand = computed(() => selectedPackageManager.value.nuxtModuleCommand);

async function copy(value: string, key: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
  } catch {}
  copied.value = key;
  setTimeout(() => {
    if (copied.value === key) copied.value = null;
  }, 1500);
}

function updateCommandWidth() {
  if (!commandMeasure.value) return;
  commandWidth.value = Math.ceil(commandMeasure.value.getBoundingClientRect().width);
}

onMounted(async () => {
  await nextTick();
  updateCommandWidth();
});

watch(activeCommand, async () => {
  copied.value = null;
  await nextTick();
  updateCommandWidth();
});

watch(activePackageManager, () => {
  copied.value = null;
});
</script>

<template>
  <div class="inline-flex max-w-full flex-col items-stretch gap-3">
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
        class="flex shrink-0 items-center gap-1 rounded-full bg-neutral-100/80 p-1 text-sm ring-1 ring-neutral-200/80 dark:bg-neutral-900/80 dark:ring-white/10"
        role="radiogroup"
        aria-label="Package manager"
      >
        <button
          v-for="manager in packageManagers"
          :key="manager.value"
          type="button"
          role="radio"
          :aria-checked="activePackageManager === manager.value"
          :aria-label="manager.label"
          class="inline-flex h-8 min-w-8 items-center justify-center overflow-hidden rounded-full font-medium transition-[width,color,transform,background-color,box-shadow] duration-[220ms] ease-[cubic-bezier(0.23,1,0.32,1)] active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 motion-reduce:transition-none"
          :class="
            activePackageManager === manager.value
              ? 'w-22 bg-white px-2.5 text-neutral-950 shadow-sm ring-1 ring-black/5 dark:bg-neutral-800 dark:text-neutral-50 dark:ring-white/10'
              : 'w-8 px-0 text-neutral-500 grayscale hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100'
          "
          @click="activePackageManager = manager.value"
        >
          <UIcon :name="manager.icon" class="size-3.5 shrink-0" aria-hidden="true" />
          <span
            class="overflow-hidden whitespace-nowrap transition-[max-width,opacity,margin-left] duration-[180ms] ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
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

    <UButton
      type="button"
      color="neutral"
      variant="ghost"
      :aria-label="copied === 'cmd' ? 'Copied command' : 'Copy command'"
      class="group inline-flex w-max max-w-full items-center gap-1.5 rounded-full bg-white px-2.5 py-1.5 text-left shadow-sm ring-1 ring-neutral-200 transition-[box-shadow,background-color] duration-200 hover:bg-white hover:ring-neutral-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 dark:bg-neutral-950 dark:ring-white/10 dark:hover:bg-neutral-950 dark:hover:ring-white/20"
      @click="copy(activeCommand, 'cmd')"
    >
      <span class="font-mono text-base text-neutral-300 select-none" aria-hidden="true">$</span>
      <span
        class="relative block max-w-[calc(100vw-7rem)] min-w-0 overflow-hidden font-mono text-[0.9375rem] text-neutral-950 transition-[width] duration-[400ms] ease-[cubic-bezier(0.23,1,0.32,1)] dark:text-neutral-100"
        :style="commandWidth ? { width: `${commandWidth}px` } : undefined"
      >
        <span
          ref="commandMeasure"
          aria-hidden="true"
          class="pointer-events-none invisible absolute whitespace-nowrap"
          >{{ activeCommand }}</span
        >
        <Transition name="command-swap" mode="out-in">
          <code :key="activeCommand" class="block truncate whitespace-nowrap py-1">
            {{ activeCommand }}
          </code>
        </Transition>
      </span>
      <span
        class="relative ml-1 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-neutral-900 transition-colors group-hover:bg-neutral-100 dark:text-neutral-100 dark:group-hover:bg-white/10"
      >
        <Transition name="copy-icon" mode="out-in">
          <UIcon
            :key="copied === 'cmd' ? 'check' : 'copy'"
            :name="copied === 'cmd' ? 'i-lucide-check' : 'i-lucide-copy'"
            class="size-3.5"
            :class="copied === 'cmd' ? 'text-emerald-500' : ''"
            aria-hidden="true"
          />
        </Transition>
      </span>
    </UButton>

    <div
      v-if="activeCommandTab === 'humans' && showNuxtModule"
      class="mt-1 flex w-full max-w-xl flex-col items-start gap-2.5"
      aria-label="Nuxt module command"
    >
      <div
        class="ml-8 inline-flex items-center gap-2 text-sm font-semibold text-neutral-900 dark:text-neutral-100"
      >
        <UIcon
          name="i-simple-icons-nuxtdotjs"
          class="size-4 shrink-0 grayscale"
          aria-hidden="true"
        />
        <span>Nuxt</span>
      </div>
      <UButton
        type="button"
        color="neutral"
        variant="ghost"
        :aria-label="
          copied === 'nuxt-module' ? 'Copied Nuxt module command' : 'Copy Nuxt module command'
        "
        class="group inline-flex max-w-full items-center gap-1.5 rounded-full bg-white px-2.5 py-1.5 text-left shadow-sm ring-1 ring-neutral-200 transition-[box-shadow,background-color] duration-200 hover:bg-white hover:ring-neutral-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 dark:bg-neutral-950 dark:ring-white/10 dark:hover:bg-neutral-950 dark:hover:ring-white/20"
        @click="copy(nuxtModuleCommand, 'nuxt-module')"
      >
        <span class="font-mono text-base text-neutral-300 select-none" aria-hidden="true">$</span>
        <span class="block min-w-0 overflow-hidden">
          <code
            class="block max-w-[calc(100vw-7rem)] truncate whitespace-nowrap py-1 font-mono text-[0.9375rem] text-neutral-950 dark:text-neutral-100"
          >
            {{ nuxtModuleCommand }}
          </code>
        </span>
        <span
          class="relative ml-1 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-neutral-900 transition-colors group-hover:bg-neutral-100 dark:text-neutral-100 dark:group-hover:bg-white/10"
        >
          <Transition name="copy-icon" mode="out-in">
            <UIcon
              :key="copied === 'nuxt-module' ? 'check' : 'copy'"
              :name="copied === 'nuxt-module' ? 'i-lucide-check' : 'i-lucide-copy'"
              class="size-3.5"
              :class="copied === 'nuxt-module' ? 'text-emerald-500' : ''"
              aria-hidden="true"
            />
          </Transition>
        </span>
      </UButton>
    </div>

    <UButton
      to="/cli"
      color="neutral"
      variant="link"
      trailing-icon="i-lucide-arrow-right"
      class="px-2 py-1.5 text-sm font-medium text-neutral-700 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100"
    >
      CLI
    </UButton>
  </div>
</template>
