<script setup lang="ts">
import { createBoundedLogBuffer } from "~/utils/logBuffer";
import { checkWcCapabilities } from "~/utils/wcCapabilities";

const caps = checkWcCapabilities();
const { status, errorMsg, result, framework, phaseLabel, scan, scanDemo, setLogSink } =
  useDoctorWc();

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

async function onScan() {
  if (busy.value) return;
  const input = repoUrl.value.trim();
  if (!input) {
    inputError.value = "Enter a public GitHub repo, for example nuxt/starter.";
    return;
  }
  inputError.value = null;
  hasInteracted.value = true;
  logsOpen.value = true;
  logBuffer.clear();
  await nextTick();
  terminal.value?.reset();
  await scan(input);
}
async function onDemo() {
  if (busy.value) return;
  inputError.value = null;
  hasInteracted.value = true;
  logsOpen.value = true;
  logBuffer.clear();
  await nextTick();
  terminal.value?.reset();
  await scanDemo();
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
          Scan a public GitHub repo
        </label>
        <span
          v-if="phaseLabel"
          class="inline-flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-500"
        >
          <span class="size-1.5 bg-emerald-500 animate-pulse" aria-hidden="true" />
          {{ phaseLabel }}
        </span>
      </div>
      <div class="flex flex-col gap-2 sm:flex-row">
        <input
          id="scan-repo"
          v-model="repoUrl"
          type="text"
          placeholder="nuxt/starter or https://github.com/owner/repo"
          class="flex-1 bg-neutral-50 px-3 py-2 font-mono text-sm ring-1 ring-neutral-200 placeholder:text-neutral-400 focus:outline-none focus:ring-emerald-500 dark:bg-neutral-950 dark:ring-neutral-800"
          :disabled="busy"
          @keyup.enter="onScan"
        />
        <button
          type="button"
          class="inline-flex items-center justify-center gap-1.5 bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50 dark:bg-emerald-500 dark:hover:bg-emerald-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
          :disabled="busy"
          @click="onScan"
        >
          <UIcon v-if="busy" name="i-lucide-loader-circle" class="size-4 animate-spin" />
          <UIcon v-else name="i-lucide-play" class="size-4" />
          {{ busy ? "Scanning…" : "Scan" }}
        </button>
        <button
          type="button"
          class="inline-flex items-center justify-center gap-1.5 bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-200 disabled:opacity-50 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
          :disabled="busy"
          @click="onDemo"
        >
          Try sample
        </button>
      </div>
      <p v-if="inputError || errorMsg" class="text-xs text-rose-600 dark:text-rose-400">
        {{ inputError || errorMsg }}
      </p>
    </div>

    <div
      v-if="hasInteracted"
      class="grow-section border-t border-neutral-100 dark:border-neutral-800"
    >
      <button
        type="button"
        class="flex w-full items-center gap-1.5 px-5 py-2.5 text-xs font-medium text-neutral-500 hover:text-neutral-900 sm:px-6 dark:text-neutral-500 dark:hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
        @click="logsOpen = !logsOpen"
      >
        <UIcon
          :name="logsOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
          class="size-3.5"
        />
        Terminal
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

@media (prefers-reduced-motion: reduce) {
  .grow-section {
    animation: none;
  }
}
</style>
