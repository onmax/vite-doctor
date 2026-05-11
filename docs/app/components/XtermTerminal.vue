<script setup lang="ts">
import type { Terminal as TerminalType } from "@xterm/xterm";
import type { FitAddon as FitAddonType } from "@xterm/addon-fit";

const props = defineProps<{ collapsed?: boolean }>();
const el = ref<HTMLDivElement | null>(null);
let term: TerminalType | null = null;
let fit: FitAddonType | null = null;
let ro: ResizeObserver | null = null;
let pending = "";

function write(data: string) {
  if (!term) {
    pending += data;
    return;
  }
  term.write(data);
}

function clear() {
  pending = "";
  term?.clear();
}

function reset(data = "") {
  pending = data;
  term?.clear();
  if (term && pending) {
    term.write(pending);
    pending = "";
  }
}
defineExpose({ write, clear, reset });

onMounted(async () => {
  if (!el.value) return;
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/xterm/css/xterm.css"),
  ]);
  if (!el.value) return;
  term = new Terminal({
    fontFamily: "IBM Plex Mono, ui-monospace, monospace",
    fontSize: 12,
    theme: { background: "#0a0a0a", foreground: "#e5e5e5" },
    cursorBlink: false,
    disableStdin: true,
    convertEol: true,
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el.value);
  if (pending) {
    term.write(pending);
    pending = "";
  }
  fit.fit();
  ro = new ResizeObserver(() => fit?.fit());
  ro.observe(el.value);
});

onBeforeUnmount(() => {
  ro?.disconnect();
  term?.dispose();
  ro = null;
  fit = null;
  term = null;
});
watch(
  () => props.collapsed,
  () => nextTick(() => fit?.fit()),
);
</script>

<template>
  <div ref="el" class="h-48 w-full overflow-hidden bg-neutral-950 ring-1 ring-neutral-800" />
</template>
