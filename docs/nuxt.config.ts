import { defineNuxtConfig } from "nuxt/config";
import { join } from "pathe";
import { env, process } from "std-env";
import { fileURLToPath } from "node:url";
import doctorPackage from "../package.json" with { type: "json" };
import { getDiagnosticDocuments, getRuleDocuments } from "./rules/source.js";

const tempDir = env.TMPDIR || env.TMP || env.TEMP || "/tmp";
const contentDatabasePath = join(tempDir, `nuxt-doctor-content-${process.pid}.sqlite`);
const contentLocalDatabasePath = join(tempDir, `nuxt-doctor-content-local-${process.pid}.sqlite`);
const frameworks = ["typescript", "nuxt", "vue", "vite", "nitro"];
const docsRoutes = ["/", "/cli"];
const frameworkRoutes = frameworks.map((framework) => `/${framework}`);
const ruleIndexRoutes = frameworks.map((framework) => `/${framework}/rules`);
const legacyRuleIndexRoutes = frameworks.map((framework) => `/rules/${framework}`);
const ruleDetailRoutes = getRuleDocuments().map((rule) => rule.path);
const diagnosticRoutes = getDiagnosticDocuments().map((diagnostic) => diagnostic.path);
const contentDumpRoutes = [
  "/__nuxt_content/diagnostics/sql_dump.txt",
  "/__nuxt_content/docs/sql_dump.txt",
  "/__nuxt_content/landing/sql_dump.txt",
  "/__nuxt_content/rules/sql_dump.txt",
];

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
      filename: contentDatabasePath,
    },
    _localDatabase: {
      type: "sqlite",
      filename: contentLocalDatabasePath,
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
    prerender: {
      concurrency: 1,
      routes: [
        ...contentDumpRoutes,
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
