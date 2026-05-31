<script setup lang="ts">
import type { RawRuleEntry } from "../utils/rule-catalog";
import { FRAMEWORK_META, type Framework } from "../utils/rule-metadata";

const props = defineProps<{
  framework: Framework;
}>();

const meta = computed(() => FRAMEWORK_META[props.framework]);
const installPath = computed(() => `/${props.framework}`);
const rulesPath = computed(() => `/${props.framework}/rules`);

const descriptions: Record<Framework, string> = {
  nuxt: "Browse the Nuxt-owned rule packs. Vue, Nitro, and Vite diagnostics have their own pages so each runtime stays easy to understand.",
  vue: "Browse Vue rules for reactivity, lifecycle, template, watcher, SSR, and security diagnostics.",
  vite: "Browse Vite rules for env exposure, define replacement, server-only imports, SSR, assets, workers, and plugin behavior.",
  nitro:
    "Browse Nitro rules for request validation, runtime config, internal fetches, redirects, and server-only execution.",
};

const runCommands: Record<Framework, string> = {
  nuxt: "pnpm nuxt doctor --rules nuxt",
  vue: "pnpm vite-doctor . --framework vue --rules vue",
  vite: "pnpm vite-doctor . --framework vite --rules vite",
  nitro: "pnpm vite-doctor . --framework nitro --rules nitro",
};

const relatedFrameworks: Record<Framework, Framework[]> = {
  nuxt: ["vue", "nitro", "vite"],
  vue: ["vite"],
  vite: ["vue", "nitro", "nuxt"],
  nitro: ["nuxt", "vite"],
};

const { data: rules } = await useAsyncData(
  () => `${props.framework}-rules-index`,
  () => queryCollection("rules").all(),
  {
    watch: [() => props.framework],
    transform: (items) => items.filter((rule) => rule.framework === props.framework),
  },
);

const pageForToc = computed(() => ({
  body: {
    toc: {
      links: [
        { id: "run-this-pack", depth: 2, text: "Run this pack" },
        { id: "browse-rules", depth: 2, text: "Browse rules" },
        { id: "related-packs", depth: 2, text: "Related packs" },
      ],
    },
  },
}));
const tocPage = computed(() => pageForToc.value as any);
</script>

<template>
  <UPage>
    <UPageHeader
      :title="`${meta.label} rules`"
      :description="descriptions[framework]"
      :headline="`${meta.pack} rule pack`"
      :ui="{ wrapper: 'flex-row items-center flex-wrap justify-between' }"
    >
      <template #links>
        <UButton :to="installPath" color="neutral" variant="outline" icon="i-lucide-book-open">
          Installation
        </UButton>
      </template>
    </UPageHeader>

    <UPageBody>
      <section id="run-this-pack" class="mb-8">
        <h2 class="text-xl font-semibold tracking-tight text-highlighted">Run this pack</h2>
        <p class="mt-2 text-muted">
          Start with Installation, then use a focused rule-pack command while you fix diagnostics.
        </p>
        <pre
          class="mt-4 overflow-x-auto rounded-md border border-default bg-muted px-4 py-3 text-sm"
        ><code>{{ runCommands[framework] }}</code></pre>
      </section>

      <section id="browse-rules">
        <h2 class="mb-4 text-xl font-semibold tracking-tight text-highlighted">Browse rules</h2>
        <RuleExplorer
          :rules="(rules || []) as RawRuleEntry[]"
          :title="`${meta.label} rules`"
          :description="descriptions[framework]"
          :current-framework="framework"
          :pack-label="meta.pack"
          framework-tabs-mode="none"
          :show-header="false"
        />
      </section>

      <section id="related-packs" class="mt-10">
        <h2 class="text-xl font-semibold tracking-tight text-highlighted">Related packs</h2>
        <p class="mt-2 text-muted">
          Follow the diagnostic prefix. A Nuxt project can emit diagnostics from more than one
          runtime-owned rule pack.
        </p>
        <div class="mt-4 grid gap-3 sm:grid-cols-3">
          <UPageCard
            v-for="related in relatedFrameworks[framework]"
            :key="related"
            :to="`/${related}/rules`"
            :icon="FRAMEWORK_META[related].icon"
            :title="`${FRAMEWORK_META[related].label} rules`"
            :description="`${FRAMEWORK_META[related].pack} diagnostics`"
          />
        </div>
      </section>
    </UPageBody>

    <template #right>
      <DocsAsideRight :page="tocPage" />
    </template>
  </UPage>
</template>
