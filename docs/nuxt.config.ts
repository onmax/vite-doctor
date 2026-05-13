import { defineNuxtConfig } from "nuxt/config";
import { join } from "pathe";
import { env, process } from "std-env";
import { fileURLToPath } from "node:url";
import { getRuleDocuments } from "./rules/source.js";

const tempDir = env.TMPDIR || env.TMP || env.TEMP || "/tmp";
const frameworkRoutes = ["/vue", "/nuxt", "/nitro", "/vite"];
const docsRoutes = ["/", ...frameworkRoutes, "/cli", "/installation", "/motivation"];
const ruleIndexRoutes = frameworkRoutes.map((route) => `/rules${route}`);
const ruleDetailRoutes = getRuleDocuments().map((rule) => rule.path);

export default defineNuxtConfig({
  extends: ["docus"],

  modules: [["vite-doctor/nuxt", { mcp: false }]],

  css: ["~/assets/css/main.css"],

  vite: {
    resolve: {
      alias: {
        extend: fileURLToPath(new URL("./app/utils/extend-default.ts", import.meta.url)),
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
    prerender: {
      routes: [...docsRoutes, ...ruleIndexRoutes, ...ruleDetailRoutes],
    },
    cloudflare: {
      nodeCompat: true,
    },
  },

  routeRules: {
    ...Object.fromEntries(docsRoutes.map((route) => [route, { prerender: true }])),
    ...Object.fromEntries(ruleIndexRoutes.map((route) => [route, { prerender: true }])),
    "/_nuxt/**": {
      headers: { "cache-control": "public, max-age=31536000, immutable" },
    },
  },

  future: { compatibilityVersion: 4 },

  compatibilityDate: "2026-05-11",
} as any);
