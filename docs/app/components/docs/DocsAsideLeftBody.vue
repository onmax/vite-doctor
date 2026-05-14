<script setup lang="ts">
import type { ContentNavigationItem } from "@nuxt/content";

const { sidebarNavigation } = useSubNavigation();

const rulesNavigation: ContentNavigationItem = {
  title: "Rules",
  path: "/rules/nuxt",
  icon: "i-lucide-list-checks",
  children: [
    {
      title: "Nuxt",
      path: "/rules/nuxt",
      icon: "i-logos-nuxt-icon",
    },
    {
      title: "Vue",
      path: "/rules/vue",
      icon: "i-logos-vue",
    },
    {
      title: "Nitro",
      path: "/rules/nitro",
      icon: "i-unjs-nitro",
    },
    {
      title: "Vite",
      path: "/rules/vite",
      icon: "i-logos-vitejs",
    },
  ],
};

const navigation = computed<ContentNavigationItem[]>(() => {
  const baseNavigation = sidebarNavigation.value || [];
  if (baseNavigation.some((item) => item.path === rulesNavigation.path)) return baseNavigation;
  return [...baseNavigation, rulesNavigation];
});
</script>

<template>
  <UContentNavigation highlight :navigation="navigation" />
</template>
