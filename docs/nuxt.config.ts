import { defineNuxtConfig } from "nuxt/config";
import { join } from "pathe";
import { env, process } from "std-env";
import { fileURLToPath } from "node:url";
import doctorPackage from "../packages/vite/package.json" with { type: "json" };
import { getRuleDocuments } from "./rules/source.js";

const tempDir = env.TMPDIR || env.TMP || env.TEMP || "/tmp";
const frameworks = ["vue", "nuxt", "nitro", "vite"];
const docsRoutes = ["/", "/cli"];
const ruleIndexRoutes = frameworks.map((framework) => `/rules/${framework}`);
const ruleDetailRoutes = getRuleDocuments().map((rule) => rule.path);

export default defineNuxtConfig({
  extends: ["docus"],

  modules: [["vite-doctor/nuxt", { mcp: false }]],

  css: ["~/assets/css/main.css"],

  runtimeConfig: {
    public: {
      doctorVersion: doctorPackage.version,
    },
  },

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
