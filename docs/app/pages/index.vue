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

type Audience = "humans" | "agents";

interface Demo {
  humansCmd: string;
  agentsCmd: string;
}

const demo: Demo = {
  humansCmd: "pnpm dlx vite-doctor",
  agentsCmd: "pnpm dlx vite-doctor --dry-run",
};

const audience = ref<Audience>("humans");

const supported = [
  { id: "vue", label: "Vue", icon: "i-logos-vue" },
  { id: "nuxt", label: "Nuxt", icon: "i-logos-nuxt-icon" },
  { id: "nitro", label: "Nitro", icon: "i-unjs-nitro" },
] as const;

const currentCmd = computed(() => (audience.value === "humans" ? demo.humansCmd : demo.agentsCmd));

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

const PATH_HEIGHT = 800;

const rowPaths: Row[] = (
  [
    {
      y: 760,
      spikes: [180, 580, 1020, 1480, 1940, 2400, 2860, 3320],
      duration: 14,
      delay: 0,
    },
  ] satisfies Array<{ y: number; spikes: number[]; duration: number; delay: number }>
).map((r) => {
  const segments = ecgSegments(r.y, r.spikes);
  return { y: r.y, duration: r.duration, delay: r.delay, segments, d: pathFromSegments(segments) };
});

onMounted(() => {
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
      :viewBox="`0 0 ${PATH_WIDTH} ${PATH_HEIGHT}`"
      preserveAspectRatio="xMidYMax slice"
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
            :height="PATH_HEIGHT"
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
        <path :d="row.d" class="[stroke-opacity:0.05] dark:[stroke-opacity:0.08]" />
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
        class="inline-flex items-center gap-2.5 rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-500"
      >
        <span
          class="inline-flex size-7 items-center justify-center rounded-md bg-emerald-600 text-white dark:bg-emerald-500"
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
          href="/vue"
          class="rounded-md px-2.5 py-1.5 text-sm font-medium text-neutral-600 hover:text-neutral-900 sm:px-3 dark:text-neutral-400 dark:hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
        >
          Docs
        </a>
        <a
          href="/rules/nuxt"
          class="rounded-md px-2.5 py-1.5 text-sm font-medium text-neutral-600 hover:text-neutral-900 sm:px-3 dark:text-neutral-400 dark:hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
        >
          Rules
        </a>
        <a
          href="https://github.com/onmax/nuxt-doctor"
          target="_blank"
          rel="noopener"
          class="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-sm font-medium text-neutral-600 hover:text-neutral-900 sm:px-3 dark:text-neutral-400 dark:hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
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
          class="relative ml-1 inline-flex size-8 items-center justify-center rounded-md text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-900 dark:hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
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
        <h1
          class="mx-auto max-w-[20ch] text-4xl font-semibold tracking-tight text-balance text-neutral-900 sm:text-5xl lg:text-6xl dark:text-neutral-100"
        >
          Catch the bugs your agents ship.
        </h1>
        <p
          class="mx-auto mt-6 max-w-[56ch] text-lg text-pretty text-neutral-600 dark:text-neutral-400"
        >
          Static-analysis CLI and Nuxt module. Flags reactivity, hydration, and runtime-config
          hazards in seconds, before they hit production.
        </p>

        <p
          class="mt-8 inline-flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm font-medium text-neutral-700 dark:text-neutral-300"
        >
          <span v-for="s in supported" :key="s.id" class="inline-flex items-center gap-1.5">
            <UIcon :name="s.icon" class="size-4 shrink-0" aria-hidden="true" />
            {{ s.label }}
          </span>
        </p>
      </section>

      <section aria-label="Install" class="pb-10">
        <div class="mb-3 flex justify-center">
          <div
            class="inline-flex items-center gap-1 rounded-full bg-neutral-100/70 p-1 text-sm ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-800"
            role="tablist"
            aria-label="Output for"
          >
            <button
              v-for="m in [
                { id: 'humans' as Audience, label: 'For Humans', icon: 'i-lucide-user' },
                { id: 'agents' as Audience, label: 'For Agents', icon: 'i-lucide-bot' },
              ]"
              :key="m.id"
              type="button"
              role="tab"
              :aria-selected="audience === m.id"
              class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium transition-transform duration-100 active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
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
          class="overflow-hidden rounded-md bg-white ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-800"
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
              class="inline-flex items-center gap-1.5 rounded-sm bg-white/5 px-2.5 py-1.5 text-sm font-medium text-neutral-200 ring-1 ring-white/10 transition-transform duration-100 hover:bg-white/10 hover:text-white active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
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

      <section aria-label="Try it live" class="pb-14">
        <div
          class="overflow-hidden rounded-md bg-white ring-1 ring-neutral-200 transition-all dark:bg-neutral-900 dark:ring-neutral-800 dark:inset-ring dark:inset-ring-white/5"
        >
          <ClientOnly>
            <ScannerPanel />
            <template #fallback>
              <MobileFallback />
            </template>
          </ClientOnly>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.lifeline-bg {
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0%,
    transparent 55%,
    black 90%,
    black 100%
  );
  mask-image: linear-gradient(to bottom, transparent 0%, transparent 55%, black 90%, black 100%);
}
</style>
