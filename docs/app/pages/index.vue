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
  scanned: number;
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
    scanned: 26,
  },
  nuxt: {
    label: "Nuxt",
    pkg: "nuxt-doctor",
    cmd: "pnpm dlx nuxt module add nuxt-doctor",
    install: "pnpm dlx nuxt module add nuxt-doctor",
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
    scanned: 38,
  },
};

const framework = ref<Framework>("nuxt");
const demo = computed(() => demos[framework.value]);
const requestUrl = useRequestURL();

const typed = ref("");
const stage = ref(0);
const progress = ref(0);
const initialized = ref(false);
let timers: ReturnType<typeof setTimeout>[] = [];

function clearTimers() {
  timers.forEach(clearTimeout);
  timers = [];
}
function schedule(fn: () => void, delay: number) {
  timers.push(setTimeout(fn, delay));
}

function tweenProgress() {
  const target = demo.value.score;
  progress.value = 0;
  const stepMs = 22;
  const totalMs = 800;
  const steps = Math.max(1, Math.round(totalMs / stepMs));
  let i = 0;
  const tick = () => {
    i += 1;
    progress.value = Math.min(target, Math.round((target * i) / steps));
    if (i < steps) timers.push(setTimeout(tick, stepMs));
  };
  tick();
}

function start() {
  clearTimers();
  typed.value = "";
  stage.value = 0;
  progress.value = 0;
  initialized.value = false;

  const cmd = demo.value.cmd;
  const charDelay = 55;
  for (let i = 0; i < cmd.length; i += 1) {
    schedule(() => (typed.value = cmd.slice(0, i + 1)), 350 + i * charDelay);
  }

  let cursor = 350 + cmd.length * charDelay + 280;
  const beat = 200;
  const totalStages = 4 + demo.value.rules.length;
  for (let s = 1; s <= totalStages; s += 1) {
    const captured = s;
    schedule(() => (stage.value = captured), cursor);
    cursor += beat;
  }
  schedule(tweenProgress, cursor + 120);
  schedule(() => (initialized.value = true), cursor + 900);
}

function refreshReport() {
  typed.value = demo.value.cmd;
  progress.value = 0;
  setTimeout(tweenProgress, 220);
}

function selectFramework(f: Framework) {
  if (framework.value === f) return;
  framework.value = f;
  if (!initialized.value) start();
  else refreshReport();
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

const ruleStageStart = 2;
const visibleRules = computed(() => {
  const count = Math.max(0, stage.value - ruleStageStart + 1);
  return demo.value.rules.slice(0, Math.min(count, demo.value.rules.length));
});

const scoreStage = computed(() => ruleStageStart + demo.value.rules.length);
const summaryStage = computed(() => scoreStage.value + 1);
const ctaStage = computed(() => summaryStage.value + 1);

const tone = computed(() => {
  const s = demo.value.score;
  if (s >= 80) return "good";
  if (s >= 60) return "warn";
  return "bad";
});

const scoreTone = computed(
  () => ({ good: "text-emerald-400", warn: "text-amber-400", bad: "text-rose-400" })[tone.value],
);
const progressTone = computed(
  () => ({ good: "bg-emerald-500", warn: "bg-amber-500", bad: "bg-rose-500" })[tone.value],
);
const borderTone = computed(
  () =>
    ({ good: "border-emerald-500/40", warn: "border-amber-500/40", bad: "border-rose-500/40" })[
      tone.value
    ],
);

const scoreFaceReady = computed(
  () => stage.value >= scoreStage.value && progress.value >= demo.value.score - 1,
);
const scoreFace = computed(() => {
  if (!scoreFaceReady.value) return { eyes: ". .", mouth: "○" };
  switch (tone.value) {
    case "good":
      return { eyes: "^ ^", mouth: "‿" };
    case "warn":
      return { eyes: "· ·", mouth: "–" };
    default:
      return { eyes: "x x", mouth: "▽" };
  }
});

function severityColor(id: string) {
  if (/security|secret|html/.test(id)) return "bg-rose-400";
  if (/ssr|hydration/.test(id)) return "bg-blue-400";
  if (/reactivity|computed|prop-mutation/.test(id)) return "bg-amber-400";
  if (/template|v-for|v-if/.test(id)) return "bg-violet-400";
  if (/middleware|fetch|runtime|state/.test(id)) return "bg-cyan-400";
  return "bg-neutral-400";
}

const agentResources = computed(() => {
  const pkg = demo.value.pkg;
  const mcpJson =
    framework.value === "nuxt"
      ? `{
  "mcpServers": {
    "${pkg}": {
      "url": "${requestUrl.origin}/mcp"
    }
  }
}`
      : "";
  return {
    mcpJson,
    rawUrl: `${requestUrl.origin}/raw/${framework.value}.md`,
    rulesCmd: `pnpm dlx ${pkg} rules --format json`,
  };
});

const ctaButtonClass =
  "rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-sm font-mono text-neutral-100 hover:bg-white/10 hover:border-white/10 hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400";

const smallCopyClass =
  "rounded border border-white/10 px-2 py-0.5 text-xs text-neutral-400 hover:bg-white/5 hover:text-neutral-100 hover:border-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400";

onMounted(start);
onBeforeUnmount(clearTimers);
</script>

<template>
  <div
    class="min-h-dvh w-full antialiased font-mono text-sm leading-relaxed text-neutral-300 selection:bg-emerald-500/30 selection:text-emerald-50"
    style="background: #0a0a0a"
  >
    <header class="mx-auto flex max-w-5xl items-center justify-between px-6 pt-6 sm:px-8 sm:pt-8">
      <div class="flex items-center gap-2 text-neutral-400">
        <img :src="demo.logo" alt="" class="size-5 transition-opacity" />
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

    <main
      class="mx-auto grid max-w-5xl gap-6 px-6 pb-32 pt-10 sm:px-8 sm:pb-32 lg:grid-cols-[1fr_1.05fr] lg:gap-8"
    >
      <!-- Terminal panel -->
      <section class="lg:sticky lg:top-8 lg:self-start">
        <div
          class="overflow-hidden rounded-lg border border-white/10 bg-black/40 shadow-2xl shadow-black/40"
        >
          <div
            class="flex items-center justify-between border-b border-white/5 bg-white/[0.03] px-4 py-2 text-xs text-neutral-500"
          >
            <span>~/my-app — {{ demo.pkg }}</span>
            <span v-if="stage >= summaryStage" class="text-neutral-600">{{ demo.duration }}</span>
          </div>
          <div class="px-4 py-4 sm:px-5 sm:py-5 leading-7">
            <div>
              <span class="text-neutral-500">$ </span>
              <span class="text-neutral-100">{{ typed }}</span>
              <span
                v-if="stage < 1"
                class="ml-0.5 inline-block h-[1em] w-[0.55em] -mb-0.5 align-middle bg-neutral-200 cursor-blink"
                aria-hidden="true"
              />
            </div>

            <div v-if="stage >= 1" class="mt-3 text-neutral-500">
              <span class="text-neutral-600">› </span>scanning {{ demo.scanned }} files…
            </div>

            <TransitionGroup
              tag="ul"
              class="relative mt-2 space-y-1"
              enter-active-class="transition duration-300 ease-out [transition-delay:var(--rule-delay,0ms)]"
              enter-from-class="opacity-0 -translate-y-1"
              leave-active-class="absolute w-full transition duration-200 ease-in"
              leave-to-class="opacity-0 translate-y-1"
              move-class="transition-transform duration-300"
            >
              <li
                v-for="(rule, i) in visibleRules"
                :key="rule.id"
                class="flex items-baseline gap-2"
                :style="{ '--rule-delay': `${i * 35}ms` }"
              >
                <span
                  class="self-center inline-block size-1.5 rounded-full"
                  :class="severityColor(rule.id)"
                />
                <span class="text-rose-300">✗</span>
                <span class="text-neutral-200 break-all">{{ rule.id }}</span>
                <span class="text-neutral-500">×{{ rule.count }}</span>
              </li>
            </TransitionGroup>

            <div v-if="stage >= summaryStage" class="mt-4 text-neutral-500">
              <span class="text-rose-400">✗</span> done in {{ demo.duration }} —
              {{ demo.total }} issues across {{ demo.files }}
            </div>
          </div>
        </div>
      </section>

      <!-- Report panel -->
      <section>
        <div class="flex items-center gap-3">
          <img :src="demo.logo" alt="" class="size-7 transition-transform" />
          <span class="text-base text-neutral-100">{{ demo.pkg }}</span>
        </div>
        <p class="mt-3 text-pretty text-neutral-200 text-base max-w-[42ch]">{{ demo.tagline }}</p>
        <p class="mt-1 text-neutral-500 max-w-[44ch]">{{ demo.works }}</p>

        <!-- Score hero -->
        <div
          class="mt-7 rounded-lg border bg-white/[0.02] p-5 transition-colors duration-300"
          :class="borderTone"
        >
          <div class="flex items-center gap-5">
            <div
              class="inline-flex flex-col items-center gap-0.5 rounded-md border px-3 py-2 leading-none transition-colors duration-300"
              :class="[scoreTone, borderTone]"
              aria-hidden="true"
            >
              <span>{{ scoreFace.eyes }}</span>
              <span>{{ scoreFace.mouth }}</span>
            </div>
            <div class="flex-1 min-w-0">
              <div v-if="stage >= scoreStage" class="flex items-baseline gap-2">
                <span
                  class="text-5xl font-medium tabular-nums leading-none transition-colors duration-300"
                  :class="scoreTone"
                  >{{ progress }}</span
                >
                <span class="text-neutral-500">/ 100</span>
              </div>
              <div v-else class="text-neutral-500">Awaiting diagnosis…</div>
              <div
                v-if="stage >= scoreStage"
                class="mt-1 transition-colors duration-300"
                :class="scoreTone"
              >
                {{ demo.level }}
              </div>
            </div>
          </div>
          <div class="mt-4 h-2 overflow-hidden rounded-full bg-neutral-800/60">
            <div
              class="h-full rounded-full transition-[width] duration-100 ease-out"
              :class="progressTone"
              :style="{ width: `${progress}%` }"
            />
          </div>
        </div>

        <p v-if="stage >= summaryStage" class="mt-4 text-neutral-400">
          <span class="text-rose-400">{{ demo.total }} issues</span>
          <span class="text-neutral-500">
            across {{ demo.files }} files in {{ demo.duration }}</span
          >
        </p>

        <div v-if="stage >= ctaStage" class="mt-8">
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

          <Transition
            mode="out-in"
            enter-active-class="transition duration-200 ease-out"
            enter-from-class="opacity-0 translate-y-1"
            leave-active-class="transition duration-150 ease-in"
            leave-to-class="opacity-0 -translate-y-1"
          >
            <div
              v-if="audience === 'humans'"
              key="humans"
              class="mt-4 flex flex-wrap items-center gap-2 text-sm"
            >
              <UButton
                color="neutral"
                variant="outline"
                :trailing-icon="copied === 'cmd' ? 'i-lucide-check' : 'i-lucide-copy'"
                :class="ctaButtonClass"
                :ui="{ trailingIcon: 'size-3.5 text-neutral-400 group-hover:text-neutral-200' }"
                @click="copy(demo.cmd, 'cmd')"
              >
                {{ demo.install }}
                <span class="sr-only">Copy command</span>
              </UButton>

              <UButton
                :to="demo.docs"
                color="neutral"
                variant="outline"
                leading-icon="i-lucide-book-open"
                trailing-icon="i-lucide-arrow-right"
                :class="ctaButtonClass"
                :ui="{ leadingIcon: 'size-3.5', trailingIcon: 'size-3.5' }"
              >
                Read the docs
              </UButton>

              <UButton
                to="https://github.com/onmax/nuxt-doctor"
                target="_blank"
                rel="noopener"
                color="neutral"
                variant="outline"
                leading-icon="i-simple-icons-github"
                :class="ctaButtonClass"
                :ui="{ leadingIcon: 'size-3.5' }"
              >
                Star on GitHub
              </UButton>
            </div>

            <div v-else key="agents" class="mt-4 space-y-3 text-sm">
              <div
                v-if="agentResources.mcpJson"
                class="overflow-hidden rounded-md border border-white/10 bg-black/40"
              >
                <div
                  class="flex items-center justify-between border-b border-white/5 bg-white/[0.03] px-3 py-1.5 text-xs text-neutral-500"
                >
                  <span>~/.cursor/mcp.json · ~/.config/claude/mcp.json</span>
                  <UButton
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    :icon="copied === 'mcp' ? 'i-lucide-check' : 'i-lucide-copy'"
                    class="text-neutral-400 hover:text-neutral-100 hover:bg-transparent"
                    :ui="{ leadingIcon: 'size-3' }"
                    @click="copy(agentResources.mcpJson, 'mcp')"
                  >
                    Copy
                  </UButton>
                </div>
                <pre
                  class="overflow-x-auto px-3 py-2 text-xs leading-5 text-neutral-200"
                ><code>{{ agentResources.mcpJson }}</code></pre>
              </div>

              <div
                class="flex items-center gap-2 rounded-md border border-white/10 bg-white/5 px-3 py-2"
              >
                <UIcon name="i-lucide-file-text" class="size-3.5 shrink-0 text-neutral-500" />
                <code class="flex-1 truncate text-neutral-200" :title="agentResources.rawUrl">{{
                  agentResources.rawUrl
                }}</code>
                <UButton
                  color="neutral"
                  variant="outline"
                  square
                  :icon="copied === 'raw' ? 'i-lucide-check' : 'i-lucide-copy'"
                  :class="smallCopyClass"
                  :ui="{ leadingIcon: 'size-3' }"
                  @click="copy(agentResources.rawUrl, 'raw')"
                />
              </div>

              <div
                class="flex items-center gap-2 rounded-md border border-white/10 bg-white/5 px-3 py-2"
              >
                <UIcon name="i-lucide-braces" class="size-3.5 shrink-0 text-neutral-500" />
                <code class="flex-1 truncate text-neutral-200" :title="agentResources.rulesCmd">{{
                  agentResources.rulesCmd
                }}</code>
                <UButton
                  color="neutral"
                  variant="outline"
                  square
                  :icon="copied === 'rules' ? 'i-lucide-check' : 'i-lucide-copy'"
                  :class="smallCopyClass"
                  :ui="{ leadingIcon: 'size-3' }"
                  @click="copy(agentResources.rulesCmd, 'rules')"
                />
              </div>

              <p v-if="agentResources.mcpJson" class="pt-1 text-xs text-neutral-500">
                Start your Nuxt app with nuxt-doctor/module installed, then drop the snippet into
                your client's MCP config.
              </p>
              <p v-else class="pt-1 text-xs text-neutral-500">
                Paste a /raw URL into the system prompt for grounded answers.
              </p>
            </div>
          </Transition>

          <UButton
            color="neutral"
            variant="ghost"
            leading-icon="i-lucide-rotate-ccw"
            class="mt-8 text-sm text-neutral-500 hover:text-neutral-300 hover:bg-transparent px-0"
            :ui="{ leadingIcon: 'size-3.5' }"
            @click="restart"
          >
            Restart demo
          </UButton>

          <p class="mt-12 text-xs text-neutral-600">
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
      </section>
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
</style>
