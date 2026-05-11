<script setup lang="ts">
definePageMeta({ header: false, footer: false, layout: false });

useHead({
  title: "Vue Doctor & Nuxt Doctor. Catch the bugs your agents ship.",
  meta: [
    {
      name: "description",
      content:
        "Static-analysis CLI and Nuxt module. Flags reactivity, hydration, runtime config, and middleware hazards in Vue 3.5 and Nuxt 4 code before they ship.",
    },
    { name: "twitter:card", content: "summary_large_image" },
  ],
  link: [
    { rel: "preconnect", href: "https://fonts.googleapis.com" },
    { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" },
    {
      rel: "stylesheet",
      href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&display=swap",
    },
  ],
});

type Framework = "vue" | "nuxt";
type Audience = "humans" | "agents";
type Severity = "high" | "medium" | "low";

interface Finding {
  severity: Severity;
  title: string;
  description: string;
  location: string;
}

interface Demo {
  label: string;
  pkg: string;
  logo: string;
  docs: string;
  humansCmd: string;
  agentsCmd: string;
  score: number;
  total: number;
  scanned: number;
  duration: string;
  findings: Finding[];
}

const demos: Record<Framework, Demo> = {
  vue: {
    label: "Vue",
    pkg: "vue-doctor",
    logo: "/vue-doctor-logo.svg",
    docs: "/vue",
    humansCmd: "pnpm dlx vue-doctor",
    agentsCmd: "pnpm dlx vue-doctor rules --format json",
    score: 72,
    total: 14,
    scanned: 96,
    duration: "1.42s",
    findings: [
      {
        severity: "high",
        title: "v-html on untrusted input",
        description: "XSS risk: comment body bound with v-html.",
        location: "components/Comment.vue:42",
      },
      {
        severity: "medium",
        title: "Prop mutated in child",
        description: "Direct write to a v-model prop.",
        location: "components/Form.vue:18",
      },
      {
        severity: "medium",
        title: "Async function in computed()",
        description: "Computed must be synchronous.",
        location: "composables/useTotals.ts:7",
      },
      {
        severity: "medium",
        title: "v-for missing :key",
        description: "List items rendered without :key.",
        location: "components/List.vue:14",
      },
      {
        severity: "low",
        title: "window used in setup",
        description: "Browser API runs during SSR.",
        location: "composables/useScroll.ts:3",
      },
    ],
  },
  nuxt: {
    label: "Nuxt",
    pkg: "nuxt-doctor",
    logo: "/nuxt-doctor-logo.svg",
    docs: "/nuxt",
    humansCmd: "pnpm dlx nuxt module add nuxt-doctor",
    agentsCmd: "npx nuxt-doctor mcp --add cursor",
    score: 42,
    total: 16,
    scanned: 128,
    duration: "2.34s",
    findings: [
      {
        severity: "high",
        title: "Hydration mismatch",
        description: "Non-deterministic value rendered server-side.",
        location: "components/UserCard.vue:23",
      },
      {
        severity: "medium",
        title: "Runtime secret exposed",
        description: "API key reachable in the public bundle.",
        location: "composables/useApi.ts:12",
      },
      {
        severity: "medium",
        title: "Middleware data leak",
        description: "Sensitive payload returned to the client.",
        location: "middleware/auth.global.ts:1",
      },
      {
        severity: "medium",
        title: "Raw fetch in setup",
        description: "useFetch missed. Duplicates across SSR and CSR.",
        location: "composables/useUser.ts:8",
      },
      {
        severity: "low",
        title: "Non-serializable useState",
        description: "State won't transfer from server to client.",
        location: "composables/useCart.ts:5",
      },
    ],
  },
};

const framework = ref<Framework>("nuxt");
const audience = ref<Audience>("humans");
const demo = computed(() => demos[framework.value]);

// Live scan state — sample preview hides as soon as the user starts a real scan.
const { result: liveResult } = useDoctorWc();
const hasInteracted = useState<boolean>("doctor-wc-interacted", () => false);
const showSample = computed(() => !liveResult.value && !hasInteracted.value);

const supported = [
  { id: "vue", label: "Vue", icon: "i-logos-vue" },
  { id: "nuxt", label: "Nuxt", icon: "i-logos-nuxt-icon" },
  { id: "nitro", label: "Nitro", icon: "i-unjs-nitro" },
] as const;
const currentCmd = computed(() =>
  audience.value === "humans" ? demo.value.humansCmd : demo.value.agentsCmd,
);
const visibleFindings = computed(() => demo.value.findings.slice(0, 3));

const progress = ref(0);
let tweenTimers: ReturnType<typeof setTimeout>[] = [];
function clearTween() {
  tweenTimers.forEach(clearTimeout);
  tweenTimers = [];
}
function tweenProgress() {
  clearTween();
  const target = demo.value.score;
  progress.value = 0;
  const totalMs = 900;
  const stepMs = 24;
  const steps = Math.max(1, Math.round(totalMs / stepMs));
  let i = 0;
  const tick = () => {
    i += 1;
    progress.value = Math.min(target, Math.round((target * i) / steps));
    if (i < steps) tweenTimers.push(setTimeout(tick, stepMs));
  };
  tick();
}

function selectFramework(f: Framework) {
  if (framework.value === f) return;
  framework.value = f;
  tweenProgress();
}

const copied = ref<string | null>(null);
async function copy(value: string, key: string) {
  try {
    await navigator.clipboard.writeText(value);
    copied.value = key;
    setTimeout(() => {
      if (copied.value === key) copied.value = null;
    }, 1500);
  } catch {}
}

const colorMode = useColorMode();
const isDark = computed(() => colorMode.value === "dark");
function toggleTheme() {
  colorMode.preference = isDark.value ? "light" : "dark";
}

const ARC_LENGTH = 157.08;
const dashArray = computed(() => {
  const filled = (progress.value / 100) * ARC_LENGTH;
  return `${filled} ${ARC_LENGTH}`;
});

const lifelineSvg = ref<SVGSVGElement | null>(null);
const lifelineAnimations: Array<{ cancel: () => void }> = [];

const PATH_WIDTH = 3600;
const TRAIL_WIDTH = 460;

type Point = readonly [number, number];

function ecgSegments(baseY: number, spikes: number[]): Point[] {
  const segs: Point[] = [[0, baseY]];
  for (const cx of spikes) {
    segs.push(
      [cx - 60, baseY],
      [cx - 48, baseY - 5],
      [cx - 36, baseY],
      [cx - 16, baseY],
      [cx - 10, baseY + 6],
      [cx, baseY - 44],
      [cx + 10, baseY + 38],
      [cx + 16, baseY],
      [cx + 46, baseY],
      [cx + 58, baseY - 6],
      [cx + 80, baseY - 6],
      [cx + 92, baseY],
    );
  }
  segs.push([PATH_WIDTH, baseY]);
  return segs;
}

function pathFromSegments(segs: Point[]): string {
  let d = `M ${segs[0][0]} ${segs[0][1]}`;
  for (let i = 1; i < segs.length; i++) d += ` L ${segs[i][0]} ${segs[i][1]}`;
  return d;
}

// Linear interpolation of y at a given x along a monotonic polyline.
function yAtX(x: number, segs: Point[]): number {
  if (x <= segs[0][0]) return segs[0][1];
  for (let i = 1; i < segs.length; i++) {
    const [x2, y2] = segs[i];
    if (x <= x2) {
      const [x1, y1] = segs[i - 1];
      if (x2 === x1) return y2;
      return y1 + ((x - x1) / (x2 - x1)) * (y2 - y1);
    }
  }
  return segs[segs.length - 1][1];
}

function animateLinear(
  from: number,
  to: number,
  options: { duration: number; delay: number; onUpdate: (value: number) => void },
) {
  let frame = 0;
  let cancelled = false;
  const distance = to - from;
  const durationMs = options.duration * 1000;
  const delayMs = options.delay * 1000;
  const startedAt = performance.now();

  const tick = (now: number) => {
    if (cancelled) return;
    const elapsed = (((now - startedAt - delayMs) % durationMs) + durationMs) % durationMs;
    options.onUpdate(from + distance * (elapsed / durationMs));
    frame = requestAnimationFrame(tick);
  };

  frame = requestAnimationFrame(tick);
  return {
    cancel: () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    },
  };
}

interface Row {
  d: string;
  y: number;
  duration: number;
  delay: number;
  segments: Point[];
}

// Coprime-ish durations and unrelated delays keep rows visually independent.
// Spike positions are staggered per row so heartbeats don't line up vertically.
const rowPaths: Row[] = (
  [
    {
      y: 70,
      spikes: [180, 620, 1080, 1540, 2020, 2480, 2940, 3380],
      duration: 11,
      delay: 0,
    },
    {
      y: 200,
      spikes: [340, 820, 1280, 1760, 2240, 2700, 3160],
      duration: 17,
      delay: 3.2,
    },
    {
      y: 330,
      spikes: [240, 720, 1180, 1620, 2080, 2540, 3020, 3460],
      duration: 13,
      delay: 1.7,
    },
    {
      y: 460,
      spikes: [420, 880, 1340, 1820, 2280, 2760, 3220],
      duration: 19,
      delay: 7.4,
    },
    {
      y: 590,
      spikes: [120, 580, 1020, 1500, 1960, 2420, 2880, 3340],
      duration: 9,
      delay: 5.1,
    },
  ] satisfies Array<{ y: number; spikes: number[]; duration: number; delay: number }>
).map((r) => {
  const segments = ecgSegments(r.y, r.spikes);
  return { y: r.y, duration: r.duration, delay: r.delay, segments, d: pathFromSegments(segments) };
});

const scanTimeLabel = ref("just now");
function formatRelativeTime(date: Date) {
  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return date.toLocaleDateString();
}

let scanAt: Date | null = null;
let relTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  scanAt = new Date();
  scanTimeLabel.value = formatRelativeTime(scanAt);
  relTimer = setInterval(() => {
    if (scanAt) scanTimeLabel.value = formatRelativeTime(scanAt);
  }, 1000);
  tweenProgress();

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!lifelineSvg.value || reduced) return;

  rowPaths.forEach((row, i) => {
    const rect = lifelineSvg.value!.querySelector<SVGRectElement>(`.trail-rect[data-row="${i}"]`);
    const dot = lifelineSvg.value!.querySelector<SVGCircleElement>(`.dot[data-row="${i}"]`);
    if (!rect || !dot) return;

    lifelineAnimations.push(
      animateLinear(-TRAIL_WIDTH, PATH_WIDTH, {
        duration: row.duration,
        delay: -row.delay,
        onUpdate: (rectX) => {
          rect.setAttribute("x", String(rectX));
          const headX = rectX + TRAIL_WIDTH;
          dot.setAttribute("cx", String(headX));
          dot.setAttribute("cy", String(yAtX(headX, row.segments)));
        },
      }),
    );
  });
});
onBeforeUnmount(() => {
  clearTween();
  if (relTimer) clearInterval(relTimer);
  lifelineAnimations.forEach((a) => a?.cancel?.());
  lifelineAnimations.length = 0;
});
</script>

<template>
  <div
    class="relative min-h-dvh w-full antialiased isolate overflow-hidden bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100 selection:bg-emerald-500/20 selection:text-emerald-900 dark:selection:text-emerald-50"
  >
    <svg
      ref="lifelineSvg"
      aria-hidden="true"
      class="lifeline-bg pointer-events-none absolute inset-0 -z-10 size-full text-emerald-700 dark:text-emerald-300"
    >
      <defs>
        <linearGradient id="lifeline-trail" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stop-color="white" stop-opacity="0" />
          <stop offset="70%" stop-color="white" stop-opacity="0.55" />
          <stop offset="100%" stop-color="white" stop-opacity="1" />
        </linearGradient>
        <mask
          v-for="(row, i) in rowPaths"
          :id="`lifeline-mask-${i}`"
          :key="`m-${i}`"
          maskUnits="userSpaceOnUse"
        >
          <rect
            class="trail-rect"
            :data-row="i"
            :x="-TRAIL_WIDTH"
            y="0"
            :width="TRAIL_WIDTH"
            height="100%"
            fill="url(#lifeline-trail)"
          />
        </mask>
      </defs>

      <g
        v-for="(row, i) in rowPaths"
        :key="`r-${i}`"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path :d="row.d" class="[stroke-opacity:0.07] dark:[stroke-opacity:0.1]" />
        <path
          :d="row.d"
          :mask="`url(#lifeline-mask-${i})`"
          class="[stroke-opacity:0.55] dark:[stroke-opacity:0.75]"
        />
        <circle
          class="dot [fill-opacity:0.7] dark:[fill-opacity:0.9]"
          :data-row="i"
          cx="0"
          :cy="row.y"
          r="3"
          fill="currentColor"
        />
      </g>
    </svg>

    <header class="mx-auto flex max-w-7xl items-center justify-between px-6 pt-6 sm:px-10 sm:pt-7">
      <a
        href="/"
        aria-label="Homepage"
        class="inline-flex items-center gap-2.5 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-500"
      >
        <span
          class="inline-flex size-7 items-center justify-center rounded-sm bg-emerald-600 text-white dark:bg-emerald-500"
          aria-hidden="true"
        >
          <svg
            viewBox="0 0 20 20"
            class="size-3.5"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="square"
            stroke-linejoin="miter"
          >
            <path d="M5 7l3 3-3 3" />
            <path d="M10 13h5" />
          </svg>
        </span>
        <span class="text-base font-semibold tracking-tight">Doctor</span>
      </a>

      <nav class="flex items-center gap-0.5 sm:gap-1">
        <a
          href="/docs"
          class="rounded-sm px-2.5 py-1.5 text-sm font-medium text-neutral-600 hover:text-neutral-900 sm:px-3 dark:text-neutral-400 dark:hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
        >
          Docs
        </a>
        <a
          href="/rules"
          class="rounded-sm px-2.5 py-1.5 text-sm font-medium text-neutral-600 hover:text-neutral-900 sm:px-3 dark:text-neutral-400 dark:hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
        >
          Rules
        </a>
        <a
          href="https://github.com/onmax/nuxt-doctor"
          target="_blank"
          rel="noopener"
          class="inline-flex items-center gap-1 rounded-sm px-2.5 py-1.5 text-sm font-medium text-neutral-600 hover:text-neutral-900 sm:px-3 dark:text-neutral-400 dark:hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
        >
          GitHub
          <UIcon
            name="i-lucide-arrow-up-right"
            class="hidden size-3.5 shrink-0 sm:inline-block"
            aria-hidden="true"
          />
        </a>
        <button
          type="button"
          :aria-label="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
          class="relative ml-1 inline-flex size-8 items-center justify-center rounded-sm text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-900 dark:hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
          @click="toggleTheme"
        >
          <UIcon
            :name="isDark ? 'i-lucide-sun' : 'i-lucide-moon'"
            class="size-4"
            aria-hidden="true"
          />
        </button>
      </nav>
    </header>

    <main class="mx-auto max-w-3xl px-6 pb-20 sm:px-10">
      <section class="pt-10 pb-12 text-center sm:pt-14 lg:pt-20 lg:pb-16">
        <p
          class="inline-flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-xs font-medium tracking-wider text-neutral-500 uppercase dark:text-neutral-500"
        >
          <span>Works with</span>
          <span class="flex items-center gap-x-3">
            <span v-for="(s, i) in supported" :key="s.id" class="contents">
              <span v-if="i > 0" class="text-neutral-300 dark:text-neutral-700" aria-hidden="true"
                >·</span
              >
              <span class="inline-flex items-center gap-1.5 text-neutral-700 dark:text-neutral-300">
                <UIcon :name="s.icon" class="size-4 shrink-0" aria-hidden="true" />
                {{ s.label }}
              </span>
            </span>
          </span>
        </p>

        <h1
          class="mx-auto mt-8 max-w-[20ch] text-4xl font-semibold tracking-tight text-balance text-neutral-900 sm:text-5xl lg:text-6xl dark:text-neutral-100"
        >
          Catch the bugs your agents ship.
        </h1>
        <p
          class="mx-auto mt-6 max-w-[56ch] text-lg text-pretty text-neutral-600 dark:text-neutral-400"
        >
          Static-analysis CLI and Nuxt module. Flags reactivity, hydration, and runtime-config
          hazards in seconds, before they hit production.
        </p>
      </section>

      <section aria-label="Install" class="pb-10">
        <div class="mb-3 flex flex-wrap items-center justify-center gap-2 sm:justify-between">
          <div
            class="inline-flex items-center gap-1 rounded-full bg-neutral-100/70 p-1 text-sm ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-800"
            role="tablist"
            aria-label="Framework"
          >
            <button
              v-for="f in ['vue', 'nuxt'] as Framework[]"
              :key="f"
              type="button"
              role="tab"
              :aria-selected="framework === f"
              class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
              :class="
                framework === f
                  ? 'bg-white text-neutral-900 ring-1 ring-neutral-200 dark:bg-neutral-800 dark:text-neutral-100 dark:ring-neutral-700'
                  : 'text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100'
              "
              @click="selectFramework(f)"
            >
              <img :src="demos[f].logo" alt="" class="size-3.5" />
              {{ demos[f].label }}
            </button>
          </div>

          <div
            class="inline-flex items-center gap-1 rounded-full bg-neutral-100/70 p-1 text-sm ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-800"
            role="tablist"
            aria-label="Audience"
          >
            <button
              v-for="m in [
                { id: 'humans' as Audience, label: 'Humans', icon: 'i-lucide-user' },
                { id: 'agents' as Audience, label: 'Agents', icon: 'i-lucide-bot' },
              ]"
              :key="m.id"
              type="button"
              role="tab"
              :aria-selected="audience === m.id"
              class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
              :class="
                audience === m.id
                  ? 'bg-white text-neutral-900 ring-1 ring-neutral-200 dark:bg-neutral-800 dark:text-neutral-100 dark:ring-neutral-700'
                  : 'text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100'
              "
              @click="audience = m.id"
            >
              <UIcon :name="m.icon" class="size-3.5 shrink-0" aria-hidden="true" />
              {{ m.label }}
            </button>
          </div>
        </div>

        <div
          class="overflow-hidden bg-white ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-800"
        >
          <div
            class="flex items-center gap-2 bg-neutral-950 px-4 py-3 dark:inset-ring dark:inset-ring-white/5"
          >
            <span class="font-mono text-sm text-emerald-400 select-none" aria-hidden="true">$</span>
            <code
              class="flex-1 truncate font-mono text-[0.9375rem] text-neutral-100"
              :title="currentCmd"
              >{{ currentCmd }}</code
            >
            <button
              type="button"
              :aria-label="copied === 'cmd' ? 'Copied' : 'Copy command'"
              class="inline-flex items-center gap-1.5 bg-white/5 px-2.5 py-1.5 text-sm font-medium text-neutral-200 ring-1 ring-white/10 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
              @click="copy(currentCmd, 'cmd')"
            >
              <UIcon
                :name="copied === 'cmd' ? 'i-lucide-check' : 'i-lucide-copy'"
                class="size-3.5 shrink-0"
                :class="copied === 'cmd' ? 'text-emerald-400' : ''"
                aria-hidden="true"
              />
              <span class="hidden sm:inline">{{ copied === "cmd" ? "Copied" : "Copy" }}</span>
            </button>
          </div>
        </div>
      </section>

      <section aria-label="Try it live" class="pb-10">
        <div
          class="overflow-hidden bg-white ring-1 ring-neutral-200 transition-all dark:bg-neutral-900 dark:ring-neutral-800"
        >
          <ClientOnly>
            <ScannerPanel />
            <template #fallback>
              <MobileFallback :framework="framework" />
            </template>
          </ClientOnly>

          <section
            v-if="showSample"
            :key="framework"
            class="grow-section border-t border-neutral-100 dark:border-neutral-800"
          >
            <div
              class="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-neutral-100 px-5 py-3 text-sm dark:border-neutral-800"
            >
              <span class="inline-flex items-center gap-2">
                <span class="inline-block size-1.5 bg-emerald-500" aria-hidden="true" />
                <span class="font-medium text-neutral-900 dark:text-neutral-100">Sample scan</span>
              </span>
              <span
                class="hidden h-3 w-px bg-neutral-200 sm:inline-block dark:bg-neutral-800"
                aria-hidden="true"
              />
              <span class="text-neutral-500 tabular-nums dark:text-neutral-500">{{
                scanTimeLabel
              }}</span>
              <span
                class="hidden h-3 w-px bg-neutral-200 sm:inline-block dark:bg-neutral-800"
                aria-hidden="true"
              />
              <span class="font-mono text-neutral-500 tabular-nums dark:text-neutral-500">{{
                demo.duration
              }}</span>
            </div>

            <div
              class="grid grid-cols-[auto_1fr] items-center gap-6 px-5 py-5 sm:gap-8 sm:px-6 sm:py-6"
            >
              <div class="flex flex-col items-center">
                <svg viewBox="0 0 130 80" class="w-32 sm:w-36" aria-hidden="true">
                  <defs>
                    <linearGradient id="gauge-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" stop-color="var(--color-rose-500)" />
                      <stop offset="55%" stop-color="var(--color-amber-400)" />
                      <stop offset="100%" stop-color="var(--color-emerald-500)" />
                    </linearGradient>
                  </defs>
                  <path
                    d="M 15 65 A 50 50 0 0 1 115 65"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="9"
                    stroke-linecap="butt"
                    class="text-neutral-200 dark:text-neutral-800"
                  />
                  <path
                    v-if="progress > 0"
                    d="M 15 65 A 50 50 0 0 1 115 65"
                    fill="none"
                    stroke="url(#gauge-gradient)"
                    stroke-width="9"
                    stroke-linecap="butt"
                    :stroke-dasharray="dashArray"
                    class="[transition:stroke-dasharray_60ms_linear]"
                  />
                </svg>
                <div class="-mt-7 flex items-baseline gap-1">
                  <span
                    class="text-3xl font-semibold tabular-nums tracking-tight text-neutral-900 sm:text-4xl dark:text-neutral-100"
                    >{{ progress }}</span
                  >
                  <span class="text-sm text-neutral-500 tabular-nums">/ 100</span>
                </div>
              </div>

              <div class="border-l border-neutral-100 pl-6 dark:border-neutral-800 sm:pl-8">
                <div class="flex items-baseline gap-2">
                  <span
                    class="text-3xl font-semibold tabular-nums tracking-tight text-neutral-900 sm:text-4xl dark:text-neutral-100"
                    >{{ demo.total }}</span
                  >
                  <span class="text-base font-medium text-neutral-700 dark:text-neutral-300"
                    >issues found</span
                  >
                </div>
                <p class="mt-1 text-sm text-neutral-500 tabular-nums dark:text-neutral-500">
                  across
                  <span class="font-medium text-neutral-700 dark:text-neutral-300">{{
                    demo.scanned
                  }}</span>
                  files
                </p>
              </div>
            </div>

            <ul
              role="list"
              class="finding-list border-t border-neutral-100 dark:border-neutral-800"
            >
              <li
                v-for="(f, i) in visibleFindings"
                :key="`${framework}-${f.location}`"
                :style="{ '--finding-index': i }"
                class="finding-row flex flex-col gap-2 border-t border-neutral-100 px-5 py-3.5 first:border-t-0 sm:grid sm:grid-cols-[88px_minmax(0,1fr)_auto] sm:items-center sm:gap-4 sm:px-6 dark:border-neutral-800"
              >
                <span class="inline-flex items-center gap-2">
                  <span
                    class="inline-block size-1.5 shrink-0"
                    :class="{
                      'bg-rose-500': f.severity === 'high',
                      'bg-amber-500': f.severity === 'medium',
                      'bg-sky-500': f.severity === 'low',
                    }"
                    aria-hidden="true"
                  />
                  <span
                    class="text-sm font-medium capitalize"
                    :class="{
                      'text-rose-700 dark:text-rose-300': f.severity === 'high',
                      'text-amber-700 dark:text-amber-300': f.severity === 'medium',
                      'text-sky-700 dark:text-sky-300': f.severity === 'low',
                    }"
                    >{{ f.severity }}</span
                  >
                </span>
                <div class="min-w-0">
                  <p class="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                    {{ f.title }}
                  </p>
                  <p class="mt-0.5 text-sm text-neutral-500 text-pretty dark:text-neutral-500">
                    {{ f.description }}
                  </p>
                </div>
                <code
                  class="truncate font-mono text-xs text-neutral-500 sm:text-[0.8125rem] sm:text-right dark:text-neutral-500"
                  :title="f.location"
                  >{{ f.location }}</code
                >
              </li>
            </ul>

            <a
              :href="demo.docs"
              class="flex items-center justify-between border-t border-neutral-100 px-5 py-3.5 text-sm font-medium text-emerald-700 hover:bg-emerald-50/60 hover:text-emerald-800 sm:px-6 dark:border-neutral-800 dark:text-emerald-400 dark:hover:bg-emerald-500/5 dark:hover:text-emerald-300 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-emerald-500"
            >
              See all {{ demo.total }} issues
              <UIcon name="i-lucide-arrow-right" class="size-4 shrink-0" aria-hidden="true" />
            </a>
          </section>
        </div>
      </section>

      <nav class="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 pt-4 text-sm">
        <a
          :href="demo.docs"
          class="inline-flex items-center gap-1.5 font-medium text-emerald-700 hover:text-emerald-800 dark:text-emerald-400 dark:hover:text-emerald-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
        >
          Read the {{ demo.label }} Doctor docs
          <UIcon name="i-lucide-arrow-right" class="size-3.5 shrink-0" aria-hidden="true" />
        </a>
        <span class="h-3 w-px bg-neutral-200 dark:bg-neutral-800" aria-hidden="true" />
        <a
          href="/rules"
          class="text-neutral-500 hover:text-neutral-900 dark:text-neutral-500 dark:hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
        >Browse all rules</a>
        <span class="h-3 w-px bg-neutral-200 dark:bg-neutral-800" aria-hidden="true" />
        <a
          href="https://github.com/onmax/nuxt-doctor"
          target="_blank"
          rel="noopener"
          class="inline-flex items-center gap-1 text-neutral-500 hover:text-neutral-900 dark:text-neutral-500 dark:hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
        >
          Star on GitHub
          <UIcon name="i-lucide-arrow-up-right" class="size-3 shrink-0" aria-hidden="true" />
        </a>
      </nav>
    </main>
  </div>
</template>

<style scoped>
.finding-list {
  margin: 0;
  padding: 0;
}

.finding-row {
  animation: finding-in 320ms cubic-bezier(0.2, 0.6, 0.2, 1) both;
  animation-delay: calc(var(--finding-index) * 70ms + 80ms);
}

@keyframes finding-in {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}

.grow-section {
  animation: grow-in 360ms cubic-bezier(0.2, 0.7, 0.2, 1) both;
}

@keyframes grow-in {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  .finding-row,
  .grow-section { animation: none; }
}
</style>
