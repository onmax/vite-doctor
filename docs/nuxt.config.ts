import { defineNuxtConfig } from "nuxt/config";
import { join } from "pathe";
import { env, process } from "std-env";
import { fileURLToPath } from "node:url";
import doctorPackage from "../packages/vite/package.json" with { type: "json" };
import { getDiagnosticDocuments, getRuleDocuments } from "./rules/source.js";

const tempDir = env.TMPDIR || env.TMP || env.TEMP || "/tmp";
const frameworks = ["nuxt", "vue", "vite", "nitro"];
const docsRoutes = ["/", "/cli"];
const frameworkRoutes = frameworks.map((framework) => `/${framework}`);
const ruleIndexRoutes = frameworks.map((framework) => `/${framework}/rules`);
const legacyRuleIndexRoutes = frameworks.map((framework) => `/rules/${framework}`);
const ruleDetailRoutes = getRuleDocuments().map((rule) => rule.path);
const diagnosticRoutes = getDiagnosticDocuments().map((diagnostic) => diagnostic.path);

export default defineNuxtConfig({
  extends: ["docus"],

  modules: [["vite-doctor/nuxt"]],

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
      link: [
        { rel: "icon", type: "image/png", href: "/favicon.png" },
        { rel: "apple-touch-icon", href: "/doctor-icon.png" },
      ],
    },
  },

  devtools: { enabled: true },

  nitro: {
    preset: "cloudflare_module",
    sourceMap: false,
    publicAssets: [
      { dir: fileURLToPath(new URL("./skills", import.meta.url)), baseURL: "/.well-known/skills" },
      {
        dir: fileURLToPath(new URL("./skills", import.meta.url)),
        baseURL: "/skills/.well-known/skills",
      },
      {
        dir: fileURLToPath(new URL("./skills", import.meta.url)),
        baseURL: "/skills/.well-known/agent-skills",
      },
    ],
    prerender: {
      routes: [
        ...docsRoutes,
        ...frameworkRoutes,
        ...ruleIndexRoutes,
        ...legacyRuleIndexRoutes,
        ...ruleDetailRoutes,
        ...diagnosticRoutes,
      ],
    },
    cloudflare: {
      nodeCompat: true,
    },
  },

  routeRules: {
    ...Object.fromEntries(docsRoutes.map((route) => [route, { prerender: true }])),
    ...Object.fromEntries(frameworkRoutes.map((route) => [route, { prerender: true }])),
    ...Object.fromEntries(ruleIndexRoutes.map((route) => [route, { prerender: true }])),
    ...Object.fromEntries(legacyRuleIndexRoutes.map((route) => [route, { prerender: true }])),
    "/_nuxt/**": {
      headers: { "cache-control": "public, max-age=31536000, immutable" },
    },
  },

  future: { compatibilityVersion: 4 },

  compatibilityDate: "2026-05-11",
} as any);
