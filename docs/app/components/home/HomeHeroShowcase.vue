<script setup lang="ts">
const tabs = [
  { id: "cli", label: "CLI", icon: "i-lucide-square-terminal" },
  { id: "agents", label: "Agents", icon: "i-lucide-bot" },
  { id: "vite", label: "Vite plugin", icon: "i-lucide-plug" },
  { id: "migrate", label: "Nuxt 5", icon: "i-lucide-arrow-up-right" },
] as const;

type TabId = (typeof tabs)[number]["id"];

const active = ref<TabId>("cli");
const tabRefs = ref<HTMLButtonElement[]>([]);

function focusTab(offset: number) {
  const index = tabs.findIndex((tab) => tab.id === active.value);
  const next = (index + offset + tabs.length) % tabs.length;
  active.value = tabs[next]!.id;
  tabRefs.value[next]?.focus();
}

const cliFindings = [
  {
    path: "app/components/IssuePanel.vue:14:15",
    severity: "error",
    code: "NUXT0029",
    message: "window is browser-only and this file can run during SSR.",
    fix: "Use <ClientOnly>, onMounted(), or a .client plugin for browser-only DOM work.",
  },
  {
    path: "nuxt.config.ts:11:7",
    severity: "error",
    code: "NUXT0054",
    message: "runtimeConfig.public.apiSecret looks sensitive and will be exposed to the client.",
    fix: "Move runtimeConfig.public.apiSecret to private runtimeConfig or remove the secret.",
  },
] as const;

const agentReport = `{
  "schema": "vite-doctor.agent/v1",
  "status": "findings",
  "summary": { "blocker": 0, "error": 19, "warn": 22, "info": 3, "fixable": 2 },
  "diagnostics": [
    {
      "code": "NUXT0029",
      "rule": "nuxt/hydration/no-browser-global-in-universal-code",
      "severity": "error",
      "location": { "path": "app/components/IssuePanel.vue", "line": 14, "column": 15 },
      "message": "window is browser-only and this file can run during SSR.",
      "remediation": "Use <ClientOnly>, onMounted(), or a .client plugin for browser-only DOM work.",
      "docs": "https://vite-doctor.onmax.me/diagnostics/NUXT0029"
    }
  ],
  "next": {
    "action": "remediate",
    "instruction": "Apply the smallest remediation that resolves each owned diagnostic, run its focused verification, then rerun Doctor."
  }
}`;

type JsonToken = { text: string; kind: "key" | "string" | "number" | "punct" };

function tokenizeJsonLine(line: string) {
  const tokens: JsonToken[] = [];
  const pattern = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?)|([^"\d-]+|-)/g;
  for (const match of line.matchAll(pattern)) {
    if (match[1] && match[2]) {
      tokens.push({ text: match[1], kind: "key" }, { text: match[2], kind: "punct" });
    } else if (match[1]) tokens.push({ text: match[1], kind: "string" });
    else if (match[3]) tokens.push({ text: match[3], kind: "number" });
    else tokens.push({ text: match[0], kind: "punct" });
  }
  return tokens;
}

// Wrapped JSON lines keep a hanging indent so nesting stays readable in the narrow panel.
const agentLines = agentReport.split("\n").map((line) => {
  const content = line.trimStart();
  return { indent: line.length - content.length, tokens: tokenizeJsonLine(content) };
});

const tokenClass: Record<JsonToken["kind"], string> = {
  key: "text-sky-700 dark:text-sky-300",
  string: "text-emerald-700 dark:text-emerald-300",
  number: "text-amber-700 dark:text-amber-300",
  punct: "text-neutral-400 dark:text-neutral-500",
};

const severityClass = {
  error: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
  warn: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
} as const;
</script>

<template>
  <div class="min-w-0">
    <div
      role="tablist"
      aria-label="Doctor surfaces"
      class="mb-3 flex gap-1 overflow-x-auto [scrollbar-width:none]"
      @keydown.right.prevent="focusTab(1)"
      @keydown.left.prevent="focusTab(-1)"
    >
      <button
        v-for="tab in tabs"
        :id="`hero-tab-${tab.id}`"
        :key="tab.id"
        ref="tabRefs"
        type="button"
        role="tab"
        :aria-selected="active === tab.id"
        :aria-controls="`hero-panel-${tab.id}`"
        :tabindex="active === tab.id ? 0 : -1"
        class="inline-flex shrink-0 items-center gap-1.5 rounded-[0.375rem] px-3 py-1.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
        :class="
          active === tab.id
            ? 'bg-neutral-200/80 text-neutral-950 dark:bg-white/10 dark:text-neutral-50'
            : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-950 dark:text-neutral-400 dark:hover:bg-white/5 dark:hover:text-neutral-100'
        "
        @click="active = tab.id"
      >
        <UIcon :name="tab.icon" class="size-3.5 shrink-0" aria-hidden="true" />
        {{ tab.label }}
      </button>
    </div>

    <div
      class="relative h-[34rem] overflow-hidden rounded-[0.5rem] border border-neutral-950/10 bg-white font-mono text-[0.75rem]/5 text-neutral-700 sm:text-[0.8125rem]/6 dark:border-white/10 dark:bg-neutral-900 dark:text-neutral-300"
    >
      <div
        v-show="active === 'cli'"
        id="hero-panel-cli"
        role="tabpanel"
        aria-labelledby="hero-tab-cli"
        class="flex h-full flex-col p-5"
      >
        <p class="flex gap-2.5">
          <span class="text-emerald-600 select-none dark:text-emerald-400" aria-hidden="true"
            >❯</span
          >
          <span class="text-neutral-950 dark:text-neutral-50">pnpm dlx vite-doctor .</span>
        </p>
        <div class="mt-3 text-neutral-500 dark:text-neutral-400">
          <p>
            Detected:
            <span class="text-neutral-800 dark:text-neutral-200">Nuxt 4.5.2 + Vue 3.5.35</span>
          </p>
          <p>Runtime: nuxt@4.5.2 → nitropack@2.13.4 → h3@1.15.11</p>
        </div>
        <div class="mt-4 space-y-4">
          <div v-for="finding in cliFindings" :key="finding.path">
            <p
              class="truncate text-sky-700 underline decoration-sky-700/30 underline-offset-2 dark:text-sky-400 dark:decoration-sky-400/30"
            >
              {{ finding.path }}
            </p>
            <div class="mt-1 flex items-start gap-2.5">
              <span
                class="mt-0.5 shrink-0 rounded-[0.25rem] px-1.5 text-[0.6875rem]/[1.125rem] font-medium uppercase"
                :class="severityClass[finding.severity]"
              >
                {{ finding.severity }}
              </span>
              <span class="min-w-0 flex-1 text-neutral-950 dark:text-neutral-50">{{
                finding.message
              }}</span>
              <span class="hidden shrink-0 text-neutral-400 sm:inline dark:text-neutral-500">{{
                finding.code
              }}</span>
            </div>
            <p class="mt-1 flex gap-2 pl-1 text-neutral-500 dark:text-neutral-400">
              <span class="select-none text-neutral-300 dark:text-neutral-600" aria-hidden="true"
                >╰▶</span
              >
              <span class="min-w-0">fix: {{ finding.fix }}</span>
            </p>
          </div>
        </div>
        <div
          class="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-neutral-950/10 pt-3 dark:border-white/10"
        >
          <span class="font-medium text-rose-600 dark:text-rose-400">✖ 19 errors</span>
          <span class="font-medium text-amber-600 dark:text-amber-400">⚠ 22 warnings</span>
          <span class="ml-auto text-neutral-500 dark:text-neutral-400"
            >2 safe fixes · 23 files</span
          >
        </div>
      </div>

      <div
        v-show="active === 'agents'"
        id="hero-panel-agents"
        role="tabpanel"
        aria-labelledby="hero-tab-agents"
        class="flex h-full flex-col p-5"
      >
        <p class="flex gap-2.5">
          <span class="text-emerald-600 select-none dark:text-emerald-400" aria-hidden="true"
            >❯</span
          >
          <span class="text-neutral-950 dark:text-neutral-50"
            >pnpm dlx vite-doctor . --format agent</span
          >
        </p>
        <p class="mt-1 text-neutral-500 dark:text-neutral-400">
          Coding agents get this report automatically.
        </p>
        <code
          class="mt-3 block min-h-0 flex-1 overflow-y-auto text-[0.6875rem]/5 [scrollbar-width:thin] sm:text-xs/5"
        >
          <span
            v-for="(line, lineIndex) in agentLines"
            :key="lineIndex"
            class="block break-words"
            :style="{ paddingLeft: `${line.indent + 2}ch`, textIndent: '-2ch' }"
            ><span
              v-for="(token, index) in line.tokens"
              :key="index"
              :class="tokenClass[token.kind]"
              >{{ token.text }}</span
            ></span
          >
        </code>
      </div>

      <div
        v-show="active === 'vite'"
        id="hero-panel-vite"
        role="tabpanel"
        aria-labelledby="hero-tab-vite"
        class="flex h-full flex-col"
      >
        <div
          class="flex items-center gap-2 border-b border-neutral-950/10 px-5 py-2.5 text-neutral-500 dark:border-white/10 dark:text-neutral-400"
        >
          <UIcon name="i-logos-vitejs" class="size-3.5" aria-hidden="true" />
          vite.config.ts
        </div>
        <pre
          class="overflow-x-auto px-5 py-4 text-[0.6875rem]/5 [scrollbar-width:none] sm:text-xs/5"
        ><code><span class="text-violet-700 dark:text-violet-300">import</span> { doctor } <span class="text-violet-700 dark:text-violet-300">from</span> <span class="text-emerald-700 dark:text-emerald-300">"vite-doctor"</span>
<span class="text-violet-700 dark:text-violet-300">import</span> { defineConfig } <span class="text-violet-700 dark:text-violet-300">from</span> <span class="text-emerald-700 dark:text-emerald-300">"vite"</span>

<span class="text-violet-700 dark:text-violet-300">export default</span> <span class="text-sky-700 dark:text-sky-300">defineConfig</span>({
  define: {
    <span class="rounded-[0.125rem] bg-rose-100 underline decoration-rose-500 decoration-wavy underline-offset-4 dark:bg-rose-500/15">__API_SECRET__</span>: JSON.<span class="text-sky-700 dark:text-sky-300">stringify</span>(process.env.API_SECRET),
  },
  plugins: [
    <span class="text-sky-700 dark:text-sky-300">doctor</span>({ run: <span class="text-emerald-700 dark:text-emerald-300">"build"</span>, mode: <span class="text-emerald-700 dark:text-emerald-300">"error"</span>, maxWarnings: <span class="text-amber-700 dark:text-amber-300">0</span> }),
  ],
})</code></pre>
        <div
          class="mt-auto border-t border-neutral-950/10 bg-neutral-50 p-5 dark:border-white/10 dark:bg-neutral-950/40"
        >
          <p class="flex gap-2.5">
            <span class="text-emerald-600 select-none dark:text-emerald-400" aria-hidden="true"
              >❯</span
            >
            <span class="text-neutral-950 dark:text-neutral-50">pnpm vite build</span>
          </p>
          <p
            class="mt-3 text-sky-700 underline decoration-sky-700/30 underline-offset-2 dark:text-sky-400 dark:decoration-sky-400/30"
          >
            vite.config.ts:6:5
          </p>
          <div class="mt-1 flex items-start gap-2.5">
            <span
              class="mt-0.5 shrink-0 rounded-[0.25rem] px-1.5 text-[0.6875rem]/[1.125rem] font-medium uppercase"
              :class="severityClass.error"
              >error</span
            >
            <span class="min-w-0 flex-1 text-neutral-950 dark:text-neutral-50"
              >Vite define "__API_SECRET__" looks like a secret and will be bundled into client
              code.</span
            >
            <span class="hidden shrink-0 text-neutral-400 sm:inline dark:text-neutral-500"
              >VITE0005</span
            >
          </div>
          <p class="mt-3 font-medium text-rose-600 dark:text-rose-400">
            ✖ Build stopped: mode "error" fails on error Diagnostics.
          </p>
        </div>
      </div>

      <div
        v-show="active === 'migrate'"
        id="hero-panel-migrate"
        role="tabpanel"
        aria-labelledby="hero-tab-migrate"
        class="flex h-full flex-col p-5"
      >
        <p class="flex gap-2.5">
          <span class="text-emerald-600 select-none dark:text-emerald-400" aria-hidden="true"
            >❯</span
          >
          <span class="text-neutral-950 dark:text-neutral-50"
            >pnpm dlx vite-doctor migrate . --to nuxt@5</span
          >
        </p>
        <p class="mt-3 text-neutral-500 dark:text-neutral-400">
          Target: <span class="text-neutral-800 dark:text-neutral-200">nuxt@5</span> from Nuxt 4.4.6
          → Nitro 2.13.4 → H3 1.15.11
        </p>
        <div class="mt-4 space-y-3 border-t border-neutral-950/10 pt-4 dark:border-white/10">
          <p class="text-xs tracking-widest text-neutral-500 uppercase dark:text-neutral-400">
            Fix now on the installed runtime
          </p>
          <div class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2">
            <span class="font-medium text-rose-600 dark:text-rose-400">NITRO0014</span>
            <div>
              <p class="text-neutral-950 dark:text-neutral-50">
                nitropack/config is not a supported Nitro 3 import.
              </p>
              <p class="text-neutral-500 dark:text-neutral-400">
                → import defineConfig from "nitro"
              </p>
            </div>
            <span class="font-medium text-amber-600 dark:text-amber-400">NITRO0016</span>
            <div>
              <p class="text-neutral-950 dark:text-neutral-50">
                sendRedirect(event, ...) is an H3 v2 compatibility API.
              </p>
              <p class="text-neutral-500 dark:text-neutral-400">
                → return redirect(location, status)
              </p>
            </div>
          </div>
        </div>
        <div class="mt-4 space-y-3 border-t border-neutral-950/10 pt-4 dark:border-white/10">
          <p class="text-xs tracking-widest text-neutral-500 uppercase dark:text-neutral-400">
            Land with the upgrade
          </p>
          <div class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2">
            <span class="font-medium text-sky-700 dark:text-sky-400">nuxt</span>
            <p class="text-neutral-950 dark:text-neutral-50">
              4.4.6 → nuxt@5, future.compatibilityVersion 5
            </p>
            <span class="font-medium text-amber-600 dark:text-amber-400">NUXT0073</span>
            <div>
              <p class="text-neutral-950 dark:text-neutral-50">
                Compatibility 5 ignores unhead.legacy.
              </p>
              <p class="text-neutral-950 dark:text-neutral-50">
                Compatibility 5 ignores experimental.parseErrorData.
              </p>
            </div>
          </div>
        </div>
        <div
          class="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-neutral-950/10 pt-3 text-neutral-500 dark:border-white/10 dark:text-neutral-400"
        >
          <span class="font-medium text-neutral-950 dark:text-neutral-50">4 diagnostics</span>
          <span>2 dependency and config changes</span>
        </div>
      </div>
    </div>
  </div>
</template>
