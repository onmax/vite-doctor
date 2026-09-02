// @ts-nocheck
export default defineNuxtConfig({
  modules: ["../../../src/nuxt.ts"],
  doctor: {
    rules: {
      "nuxt/imports/no-explicit-auto-import": "off",
    },
  },
  runtimeConfig: {
    public: {
      apiSecret: "public-secret",
    },
  },
  routeRules: {
    "/admin/**": { ssr: false },
  },
});
