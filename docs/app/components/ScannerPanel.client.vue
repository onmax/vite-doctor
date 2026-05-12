<script setup lang="ts">
import { createBoundedLogBuffer } from "~/utils/logBuffer";
import { checkWcCapabilities } from "~/utils/wcCapabilities";
import type { WcStatus } from "~/composables/useDoctorWc";

const caps = checkWcCapabilities();
const { status, errorMsg, result, framework, phaseLabel, activePhase, scan, setLogSink } =
  useDoctorWc();

const samples = [
  { repo: "nuxt/starter", icon: "i-logos-nuxt-icon" },
  { repo: "atinux/atidone", icon: "i-logos-nuxt-icon" },
  { repo: "vuejs/petite-vue", icon: "i-logos-vue" },
  { repo: "vuejs/router", icon: "i-logos-vue" },
] as const;

const steps: Array<{ id: WcStatus; label: string; description: string }> = [
  {
    id: "booting",
    label: "Boot WebContainer",
    description: "Spin up an isolated Node.js sandbox in the browser.",
  },
  {
    id: "fetching",
    label: "Fetch repository",
    description: "Pull the GitHub tarball through the edge proxy.",
  },
  {
    id: "mounting",
    label: "Mount files",
    description: "Write the project tree into the sandbox.",
  },
  {
    id: "detecting",
    label: "Detect framework",
    description: "Identify Vue or Nuxt and configure rules.",
  },
  {
    id: "scanning",
    label: "Run scan",
    description: "Apply doctor rules and collect diagnostics.",
  },
];
const ORDER: WcStatus[] = ["booting", "fetching", "mounting", "detecting", "scanning"];

const repoUrl = ref("nuxt/starter");
const terminal = ref<{
  write: (data: string) => void;
  clear: () => void;
  reset: (data?: string) => void;
} | null>(null);
const logsOpen = ref(false);
const hasInteracted = useState<boolean>("doctor-wc-interacted", () => false);
const inputError = ref<string | null>(null);
const MAX_LOG_CHARS = 80_000;
const logBuffer = createBoundedLogBuffer(MAX_LOG_CHARS);

onMounted(() => {
  setLogSink((data: string) => {
    logBuffer.append(data);
    terminal.value?.write(data);
  });
  const idle = (cb: () => void) => {
    const ric = (window as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
    if (ric) ric(cb);
    else setTimeout(cb, 1500);
  };
  idle(() => {
    import("@webcontainer/api").catch(() => {});
  });
});
onBeforeUnmount(() => setLogSink(null));

const busy = computed(() =>
  ["booting", "fetching", "mounting", "detecting", "scanning"].includes(status.value),
);

type StepState = "pending" | "active" | "done" | "error";

function stateOf(stepId: WcStatus): StepState {
  const s = status.value;
  if (s === "idle") return "pending";
  if (s === "done") return "done";

  if (s === "error") {
    const errAt = activePhase.value;
    if (!errAt) return "pending";
    const errIdx = ORDER.indexOf(errAt);
    const idx = ORDER.indexOf(stepId);
    if (idx < errIdx) return "done";
    if (idx === errIdx) return "error";
    return "pending";
  }

  const cur = ORDER.indexOf(s as WcStatus);
  const idx = ORDER.indexOf(stepId);
  if (cur < 0) return "pending";
  if (idx < cur) return "done";
  if (idx === cur) return "active";
  return "pending";
}

const activeLabel = computed(() => {
  if (status.value === "done") return "Scan complete";
  if (status.value === "error") return "Scan failed";
  return phaseLabel.value || (status.value === "idle" ? "Ready" : "");
});

async function onScan() {
  if (busy.value) return;
  const input = repoUrl.value.trim();
  if (!input) {
    inputError.value = "Enter a public GitHub repo, for example nuxt/starter.";
    return;
  }
  inputError.value = null;
  hasInteracted.value = true;
  logsOpen.value = false;
  logBuffer.clear();
  await nextTick();
  terminal.value?.reset();
  await scan(input);
}

async function selectSample(repo: string) {
  if (busy.value) return;
  repoUrl.value = repo;
  await onScan();
}

watch(logsOpen, async (open) => {
  if (!open) return;
  await nextTick();
  terminal.value?.reset(logBuffer.read());
});
</script>

<template>
  <MobileFallback v-if="!caps.supported" :reason="caps.reason" />
  <div v-else class="flex flex-col">
    <div class="flex flex-col gap-3 px-5 py-4 sm:px-6">
      <div class="flex items-center justify-between gap-3">
        <label
          for="scan-repo"
          class="text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-500"
        >
          Try it on your repo
        </label>
      </div>
      <div class="flex flex-col gap-2 sm:flex-row">
        <input
          id="scan-repo"
          v-model="repoUrl"
          type="text"
          placeholder="nuxt/starter or https://github.com/owner/repo"
          class="flex-1 rounded-md bg-neutral-50 px-3 py-2 font-mono text-sm ring-1 ring-neutral-200 placeholder:text-neutral-400 focus:outline-none focus:ring-emerald-500 dark:bg-neutral-950 dark:ring-neutral-800"
          :disabled="busy"
          @keyup.enter="onScan"
        />
        <button
          type="button"
          class="inline-flex items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-transform duration-100 hover:bg-emerald-700 active:translate-y-px disabled:opacity-50 disabled:active:translate-y-0 dark:bg-emerald-500 dark:hover:bg-emerald-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
          :disabled="busy"
          @click="onScan"
        >
          <UIcon v-if="busy" name="i-lucide-loader-circle" class="size-4 animate-spin" />
          <UIcon v-else name="i-lucide-play" class="size-4" />
          {{ busy ? "Scanning…" : "Scan" }}
        </button>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <span
          class="text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-500"
        >
          Try
        </span>
        <button
          v-for="s in samples"
          :key="s.repo"
          type="button"
          class="inline-flex items-center gap-1.5 rounded-full bg-neutral-50 py-1 pr-2.5 pl-1.5 text-xs font-medium text-neutral-700 ring-1 ring-neutral-200 transition-transform duration-100 hover:bg-neutral-100 hover:text-neutral-900 active:translate-y-px disabled:opacity-50 disabled:active:translate-y-0 dark:bg-neutral-950 dark:text-neutral-300 dark:ring-neutral-800 dark:hover:bg-neutral-900 dark:hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
          :disabled="busy"
          @click="selectSample(s.repo)"
        >
          <UIcon :name="s.icon" class="size-3.5 shrink-0" aria-hidden="true" />
          <span class="font-mono">{{ s.repo }}</span>
        </button>
      </div>

      <p v-if="inputError" class="text-xs text-rose-600 dark:text-rose-400">
        {{ inputError }}
      </p>
    </div>

    <section
      v-if="hasInteracted"
      class="grow-section border-t border-neutral-100 px-5 py-5 sm:px-6 dark:border-neutral-800"
      aria-label="Scan progress"
    >
      <div class="mb-4 flex items-center justify-between gap-3">
        <div class="flex items-center gap-2">
          <span
            class="size-1.5 shrink-0"
            :class="{
              'bg-emerald-500 animate-pulse': busy,
              'bg-emerald-500': status === 'done',
              'bg-rose-500': status === 'error',
              'bg-neutral-400': status === 'idle',
            }"
            aria-hidden="true"
          />
          <p class="text-sm font-medium text-neutral-900 dark:text-neutral-100">
            {{ activeLabel }}
          </p>
        </div>
      </div>

      <ol class="grid gap-0">
        <li
          v-for="(step, i) in steps"
          :key="step.id"
          class="grid grid-cols-[auto_minmax(0,1fr)] gap-3"
        >
          <div class="flex flex-col items-center">
            <span
              class="step-dot relative flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium ring-1 transition-colors"
              :class="{
                'bg-white text-neutral-400 ring-neutral-200 dark:bg-neutral-950 dark:text-neutral-600 dark:ring-neutral-800':
                  stateOf(step.id) === 'pending',
                'bg-emerald-500 text-white ring-emerald-500 step-dot-active':
                  stateOf(step.id) === 'active',
                'bg-emerald-500 text-white ring-emerald-500': stateOf(step.id) === 'done',
                'bg-rose-500 text-white ring-rose-500': stateOf(step.id) === 'error',
              }"
            >
              <UIcon
                v-if="stateOf(step.id) === 'done'"
                name="i-lucide-check"
                class="size-3"
                aria-hidden="true"
              />
              <UIcon
                v-else-if="stateOf(step.id) === 'active'"
                name="i-lucide-loader-circle"
                class="size-3 animate-spin"
                aria-hidden="true"
              />
              <UIcon
                v-else-if="stateOf(step.id) === 'error'"
                name="i-lucide-x"
                class="size-3"
                aria-hidden="true"
              />
              <span v-else>{{ i + 1 }}</span>
            </span>
            <span
              v-if="i < steps.length - 1"
              class="my-1 w-px flex-1"
              :class="
                stateOf(step.id) === 'done'
                  ? 'bg-emerald-500/60'
                  : 'bg-neutral-200 dark:bg-neutral-800'
              "
              aria-hidden="true"
            />
          </div>

          <div class="pb-4 last:pb-0">
            <p
              class="text-sm font-medium"
              :class="{
                'text-neutral-400 dark:text-neutral-500': stateOf(step.id) === 'pending',
                'text-neutral-900 dark:text-neutral-100':
                  stateOf(step.id) === 'active' || stateOf(step.id) === 'done',
                'text-rose-700 dark:text-rose-300': stateOf(step.id) === 'error',
              }"
            >
              {{ step.label }}
            </p>
            <p class="mt-0.5 text-xs text-pretty text-neutral-500 dark:text-neutral-500">
              {{ step.description }}
            </p>
          </div>
        </li>
      </ol>

      <p
        v-if="status === 'error' && errorMsg"
        class="mt-2 text-xs text-rose-600 dark:text-rose-400"
      >
        {{ errorMsg }}
      </p>
    </section>

    <div v-if="hasInteracted" class="border-t border-neutral-100 dark:border-neutral-800">
      <button
        type="button"
        class="flex w-full items-center gap-1.5 px-5 py-2.5 text-xs font-medium text-neutral-500 hover:text-neutral-900 sm:px-6 dark:text-neutral-500 dark:hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
        @click="logsOpen = !logsOpen"
      >
        <UIcon
          :name="logsOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
          class="size-3.5"
        />
        Logs
      </button>
      <div
        v-show="logsOpen"
        class="border-t border-neutral-100 px-5 py-3 sm:px-6 dark:border-neutral-800"
      >
        <LazyXtermTerminal ref="terminal" />
      </div>
    </div>

    <LazyScanResultCard
      v-if="result"
      class="grow-section border-t border-neutral-100 dark:border-neutral-800"
      :result="result"
      :framework="framework"
    />
  </div>
</template>

<style scoped>
.grow-section {
  animation: grow-in 360ms cubic-bezier(0.2, 0.7, 0.2, 1) both;
}

@keyframes grow-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.step-dot-active::before {
  content: "";
  position: absolute;
  inset: -3px;
  border-radius: 9999px;
  border: 1px solid var(--color-emerald-500);
  opacity: 0.4;
  animation: step-pulse 1.6s ease-out infinite;
}

@keyframes step-pulse {
  0% {
    transform: scale(0.85);
    opacity: 0.55;
  }
  100% {
    transform: scale(1.4);
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .grow-section {
    animation: none;
  }
  .step-dot-active::before {
    animation: none;
  }
}
</style>
