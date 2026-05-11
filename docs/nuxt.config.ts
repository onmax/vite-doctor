import { defineNuxtConfig } from "nuxt/config";
import { join } from "pathe";
import { env, process } from "std-env";

const tempDir = env.TMPDIR || env.TMP || env.TEMP || "/tmp";

export default defineNuxtConfig({
  extends: ["docus"],

  modules: [["nuxt-doctor/module", { mcp: false }], "~~/modules/wc-fixture"],

  css: ["~/assets/css/main.css"],

  vite: {
    optimizeDeps: { exclude: ["@webcontainer/api"] },
    server: {
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
    },
  },

  routeRules: {
    "/**": {
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
    },
  },

  content: {
    database: {
      type: "sqlite",
      filename: join(tempDir, `nuxt-doctor-content-${process.pid}.sqlite`),
    },
  },

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

  nitro: {
    preset: "cloudflare_module",
    sourceMap: false,
    cloudflare: {
      nodeCompat: true,
    },
  },

  future: { compatibilityVersion: 4 },

  compatibilityDate: "2026-05-11",
} as any);
