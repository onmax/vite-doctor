import { defineNuxtConfig } from "nuxt/config";

export default defineNuxtConfig({
  extends: ["docus"],

  modules: [["nuxt-doctor/module", { mcp: false }]],

  css: ["~/assets/css/main.css"],

  app: {
    head: {
      link: [{ rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
      meta: [
        { name: "twitter:card", content: "summary_large_image" },
        { property: "og:image", content: "/nuxt-doctor-wordmark.svg" },
        { name: "twitter:image", content: "/nuxt-doctor-wordmark.svg" },
      ],
    },
  },

  devtools: { enabled: true },

  future: { compatibilityVersion: 4 },

  compatibilityDate: "2026-05-10",
});
