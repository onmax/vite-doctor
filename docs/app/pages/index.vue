<script setup lang="ts">
definePageMeta({ header: false, footer: false, layout: false });

useHead({
  title: "Vue Doctor & Nuxt Doctor — your agent writes bad Vue, this catches it.",
  meta: [
    {
      name: "description",
      content:
        "Let coding agents diagnose and fix your Vue and Nuxt code. CLI scanner for Vue 3.5 SFCs, Nuxt 4 routing, hydration, runtime config, and modules.",
    },
    { name: "twitter:card", content: "summary_large_image" },
  ],
  link: [
    { rel: "preconnect", href: "https://fonts.googleapis.com" },
    { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" },
    {
      rel: "stylesheet",
      href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap",
    },
  ],
  htmlAttrs: { class: "doctor-landing" },
});

type Framework = "vue" | "nuxt";

interface Demo {
  label: string;
  pkg: string;
  cmd: string;
  install: string;
  logo: string;
  tagline: string;
  works: string;
  rules: { id: string; count: number }[];
  score: number;
  level: string;
  files: string;
  duration: string;
  total: number;
  docs: string;
}

const demos: Record<Framework, Demo> = {
  vue: {
    label: "Vue",
    pkg: "vue-doctor",
    cmd: "pnpm dlx vue-doctor",
    install: "pnpm dlx vue-doctor",
    logo: "/vue-doctor-logo.svg",
    tagline: "Your agent writes bad Vue. This catches it.",
    works: "Works with Vue 3.5, Vite, and any SFC project.",
    rules: [
      { id: "vue/reactivity/no-prop-mutation", count: 3 },
      { id: "vue/computed/no-async", count: 2 },
      { id: "vue/template/require-v-for-key", count: 7 },
      { id: "vue/ssr/no-browser-api-in-setup", count: 4 },
      { id: "vue/security/restrict-v-html", count: 1 },
    ],
    score: 72,
    level: "Needs care",
    files: "11/26",
    duration: "1.4s",
    total: 14,
    docs: "/vue",
  },
  nuxt: {
    label: "Nuxt",
    pkg: "nuxt-doctor",
    cmd: "pnpm dlx nuxt-doctor .",
    install: "pnpm add -D nuxt-doctor",
    logo: "/nuxt-doctor-logo.svg",
    tagline: "Your agent writes bad Nuxt. This catches it.",
    works: "Works with Nuxt 4, Nitro, layers, and modules.",
    rules: [
      { id: "nuxt/runtime/no-secret-in-public-config", count: 1 },
      { id: "nuxt/middleware/no-route-middleware-api-security", count: 2 },
      { id: "nuxt/fetch/no-raw-fetch-in-setup", count: 6 },
      { id: "nuxt/hydration/no-browser-side-effects-in-setup", count: 4 },
      { id: "nuxt/state/no-nonserializable-usestate", count: 3 },
    ],
    score: 42,
    level: "Critical",
    files: "11/38",
    duration: "1.9s",
    total: 16,
    docs: "/nuxt",
  },
};

const framework = ref<Framework>("nuxt");
const demo = computed(() => demos[framework.value]);

const typed = ref("");
const stage = ref(0);
const progress = ref(0);
let timers: ReturnType<typeof setTimeout>[] = [];

function clearTimers() {
  timers.forEach(clearTimeout);
  timers = [];
}

function schedule(fn: () => void, delay: number) {
  timers.push(setTimeout(fn, delay));
}

function start() {
  clearTimers();
  typed.value = "";
  stage.value = 0;
  progress.value = 0;

  const cmd = demo.value.cmd;
  const charDelay = 55;

  for (let i = 0; i < cmd.length; i += 1) {
    schedule(() => (typed.value = cmd.slice(0, i + 1)), 350 + i * charDelay);
  }

  let cursor = 350 + cmd.length * charDelay + 280;
  const beat = 240;

  const totalStages = 6 + demo.value.rules.length;
  for (let s = 1; s <= totalStages; s += 1) {
    const captured = s;
    schedule(() => (stage.value = captured), cursor);
    cursor += beat;
  }

  schedule(() => {
    const target = demo.value.score;
    const stepMs = 22;
    const totalMs = 700;
    const steps = Math.max(1, Math.round(totalMs / stepMs));
    let i = 0;
    const tick = () => {
      i += 1;
      progress.value = Math.min(target, Math.round((target * i) / steps));
      if (i < steps) timers.push(setTimeout(tick, stepMs));
    };
    tick();
  }, cursor + 80);
}

function selectFramework(f: Framework) {
  if (framework.value === f) return;
  framework.value = f;
  start();
}

function restart() {
  start();
}

const copied = ref<string | null>(null);
async function copy(value: string, key: string) {
  try {
    await navigator.clipboard.writeText(value);
    copied.value = key;
    setTimeout(() => (copied.value = null), 1500);
  } catch {}
}

type Audience = "humans" | "agents";
const audience = ref<Audience>("humans");

const origin = computed(() => (framework.value === "vue" ? "vue.doctor" : "nuxt.doctor"));

const agentResources = computed(() => {
  const f = framework.value;
  const o = origin.value;
  return [
    {
      label: "MCP server",
      hint: "Stream rules and scan results into Claude, Cursor, and other MCP clients.",
      value: `https://${o}/mcp`,
      icon: "i-lucide-plug",
    },
    {
      label: "Docs as Markdown",
      hint: "Append /raw to any path to get clean Markdown for context.",
      value: `https://${o}/raw/${f}.md`,
      icon: "i-lucide-file-text",
    },
    {
      label: "Rule catalog",
      hint: "Full rule metadata in JSON for grounding.",
      value: `vp exec ${demo.value.pkg} rules --format json`,
      icon: "i-lucide-braces",
    },
  ];
});

onMounted(start);
onBeforeUnmount(clearTimers);

const ruleStageStart = 4;

function ruleVisible(idx: number) {
  return stage.value >= ruleStageStart + idx;
}

const scoreStage = computed(() => ruleStageStart + demo.value.rules.length);
const summaryStage = computed(() => scoreStage.value + 1);
const ctaStage = computed(() => summaryStage.value + 1);

const progressBlocks = computed(() => {
  const total = 24;
  const filled = Math.round((progress.value / 100) * total);
  return { filled, empty: total - filled };
});

const tone = computed(() => {
  const s = demo.value.score;
  if (s >= 80) return "good";
  if (s >= 60) return "warn";
  return "bad";
});

const scoreTone = computed(
  () =>
    ({
      good: "text-emerald-400",
      warn: "text-amber-400",
      bad: "text-rose-400",
    })[tone.value],
);

const progressTone = computed(
  () =>
    ({
      good: "bg-emerald-500",
      warn: "bg-amber-500",
      bad: "bg-rose-500",
    })[tone.value],
);

const borderTone = computed(
  () =>
    ({
      good: "border-emerald-500/40",
      warn: "border-amber-500/40",
      bad: "border-rose-500/40",
    })[tone.value],
);
</script>

<template>
  <div
    class="min-h-dvh w-full antialiased font-mono text-base leading-relaxed text-neutral-300 selection:bg-emerald-500/30 selection:text-emerald-50"
    style="background: #0a0a0a"
  >
    <header class="mx-auto flex max-w-3xl items-center justify-between px-6 pt-6 sm:px-8 sm:pt-8">
      <div class="flex items-center gap-2 text-neutral-500">
        <img src="/nuxt-doctor-logo.svg" alt="" class="size-5" />
        <span class="text-sm">doctor</span>
      </div>
      <div
        class="flex items-center gap-1 rounded-full border border-white/5 bg-white/5 p-1 text-sm"
        role="tablist"
        aria-label="Framework"
      >
        <button
          v-for="f in ['vue', 'nuxt'] as Framework[]"
          :key="f"
          role="tab"
          :aria-selected="framework === f"
          class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 transition-colors"
          :class="
            framework === f ? 'bg-white/10 text-white' : 'text-neutral-400 hover:text-neutral-200'
          "
          @click="selectFramework(f)"
        >
          <img :src="demos[f].logo" alt="" class="size-3.5" />
          {{ demos[f].label }}
        </button>
      </div>
    </header>

    <main class="mx-auto max-w-3xl px-6 pb-32 pt-10 sm:px-8 sm:pb-40 sm:text-lg">
      <div class="leading-7 sm:leading-8">
        <div>
          <span class="text-neutral-500">$ </span>
          <span class="text-neutral-100">{{ typed }}</span>
          <span
            v-if="stage < 1"
            class="ml-0.5 inline-block h-[1em] w-[0.55em] -mb-0.5 align-middle bg-neutral-200 cursor-blink"
            aria-hidden="true"
          />
        </div>

        <div v-if="stage >= 1" class="mt-6 flex items-center gap-2">
          <img :src="demo.logo" alt="" class="size-5" />
          <span class="text-neutral-100">{{ demo.pkg }}</span>
        </div>
        <p v-if="stage >= 2" class="mt-2 text-neutral-300 text-pretty max-w-[60ch]">
          {{ demo.tagline }}
        </p>
        <p v-if="stage >= 3" class="mt-4 text-neutral-500 max-w-[60ch]">
          {{ demo.works }}
        </p>

        <ul role="list" class="mt-6 space-y-1">
          <li
            v-for="(rule, i) in demo.rules"
            :key="rule.id"
            v-show="ruleVisible(i)"
            class="flex items-baseline gap-2"
          >
            <span class="text-neutral-600">›</span>
            <span class="text-rose-400">✗</span>
            <span class="text-rose-300">{{ rule.id }}</span>
            <span class="text-neutral-500">×{{ rule.count }}</span>
          </li>
        </ul>

        <div v-if="stage >= scoreStage" class="mt-6">
          <div
            class="inline-flex flex-col items-center gap-0.5 rounded-md border px-3 py-2 leading-none"
            :class="[scoreTone, borderTone]"
            aria-hidden="true"
          >
            <span>x x</span>
            <span>▽</span>
          </div>
          <div class="mt-3 flex items-baseline gap-2">
            <span class="text-2xl font-medium" :class="scoreTone">{{ progress }}</span>
            <span class="text-neutral-500">/ 100</span>
            <span class="ml-1" :class="scoreTone">{{ demo.level }}</span>
          </div>
          <div class="mt-2 flex gap-0.5">
            <span
              v-for="i in progressBlocks.filled"
              :key="`f${i}`"
              class="h-4 w-4"
              :class="progressTone"
              aria-hidden="true"
            />
            <span
              v-for="i in progressBlocks.empty"
              :key="`e${i}`"
              class="h-4 w-4 bg-neutral-800/60"
              aria-hidden="true"
            />
            <span class="sr-only">{{ demo.score }} out of 100, {{ demo.level }}</span>
          </div>
        </div>

        <div v-if="stage >= summaryStage" class="mt-4">
          <p class="text-neutral-300">
            <span class="text-rose-400">{{ demo.total }} issues</span>
            <span class="text-neutral-500"
              >&nbsp;across {{ demo.files }} files in {{ demo.duration }}</span
            >
          </p>
        </div>

        <div v-if="stage >= ctaStage" class="mt-10">
          <p class="text-neutral-400">Run it on your codebase:</p>

          <div
            class="mt-3 inline-flex items-center gap-1 border-b border-white/10 text-sm"
            role="tablist"
            aria-label="Audience"
          >
            <button
              v-for="m in [
                { id: 'humans', label: 'For humans', icon: 'i-lucide-user' },
                { id: 'agents', label: 'For agents', icon: 'i-lucide-bot' },
              ] as { id: Audience; label: string; icon: string }[]"
              :key="m.id"
              role="tab"
              :aria-selected="audience === m.id"
              class="-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 transition-colors"
              :class="
                audience === m.id
                  ? 'border-emerald-400 text-neutral-100'
                  : 'border-transparent text-neutral-500 hover:text-neutral-300'
              "
              @click="audience = m.id"
            >
              <UIcon :name="m.icon" class="size-4" />
              {{ m.label }}
            </button>
          </div>

          <Transition name="audience" mode="out-in">
            <div
              v-if="audience === 'humans'"
              key="humans"
              class="mt-4 flex flex-nowrap items-center gap-2 overflow-x-auto pb-1 text-sm sm:flex-wrap sm:overflow-visible"
            >
              <button
                type="button"
                class="group inline-flex shrink-0 items-center gap-2 rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-neutral-100 transition-colors hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
                @click="copy(demo.cmd, 'cmd')"
              >
                <span class="font-mono">{{ demo.install }}</span>
                <UIcon
                  :name="copied === 'cmd' ? 'i-lucide-check' : 'i-lucide-copy'"
                  class="size-3.5 text-neutral-400 group-hover:text-neutral-200"
                />
                <span class="sr-only">Copy command</span>
              </button>

              <NuxtLink
                :to="demo.docs"
                class="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-neutral-100 transition-colors hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
              >
                <UIcon name="i-lucide-book-open" class="size-3.5" />
                Read the docs
                <UIcon name="i-lucide-arrow-right" class="size-3.5" />
              </NuxtLink>

              <a
                href="https://github.com/onmax/nuxt-doctor"
                target="_blank"
                rel="noopener"
                class="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-neutral-100 transition-colors hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
              >
                <UIcon name="i-simple-icons-github" class="size-3.5" />
                Star on GitHub
              </a>
            </div>

            <div v-else key="agents" class="mt-4 space-y-2 text-sm">
              <div
                v-for="r in agentResources"
                :key="r.label"
                class="flex flex-col gap-1 rounded-md border border-white/10 bg-white/5 px-3 py-2 sm:flex-row sm:items-center sm:gap-3"
              >
                <div class="flex items-center gap-2 text-neutral-400 sm:w-44 sm:shrink-0">
                  <UIcon :name="r.icon" class="size-3.5" />
                  <span>{{ r.label }}</span>
                </div>
                <code class="flex-1 truncate font-mono text-neutral-100" :title="r.value">{{
                  r.value
                }}</code>
                <button
                  type="button"
                  class="inline-flex shrink-0 items-center gap-1 rounded border border-white/10 px-2 py-1 text-xs text-neutral-400 transition-colors hover:bg-white/5 hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
                  @click="copy(r.value, r.label)"
                >
                  <UIcon
                    :name="copied === r.label ? 'i-lucide-check' : 'i-lucide-copy'"
                    class="size-3"
                  />
                  Copy
                </button>
              </div>
              <p class="pt-1 text-xs text-neutral-500">
                Point your agent at the MCP server, or paste a `/raw` URL into the system prompt for
                grounded answers.
              </p>
            </div>
          </Transition>

          <button
            type="button"
            class="mt-8 inline-flex items-center gap-2 text-sm text-neutral-500 transition-colors hover:text-neutral-300"
            @click="restart"
          >
            <UIcon name="i-lucide-rotate-ccw" class="size-3.5" />
            Restart demo
          </button>

          <p class="mt-12 text-sm text-neutral-600">
            Inspired by
            <a
              href="https://react.doctor"
              target="_blank"
              rel="noopener"
              class="text-neutral-400 underline-offset-4 hover:text-neutral-200 hover:underline"
              >react.doctor</a
            >.
          </p>
        </div>
      </div>
    </main>
  </div>
</template>

<style>
.doctor-landing,
.doctor-landing body {
  background: #0a0a0a;
  color: #d4d4d4;
}
.doctor-landing .font-mono,
.doctor-landing main,
.doctor-landing main *,
.doctor-landing header,
.doctor-landing header * {
  font-family:
    "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
    "Courier New", monospace;
}
@keyframes doctor-cursor {
  0%,
  49% {
    opacity: 1;
  }
  50%,
  100% {
    opacity: 0;
  }
}
.cursor-blink {
  animation: doctor-cursor 1s steps(1) infinite;
}

.audience-enter-active,
.audience-leave-active {
  transition:
    opacity 180ms ease,
    transform 180ms ease;
}
.audience-enter-from {
  opacity: 0;
  transform: translateY(4px);
}
.audience-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
