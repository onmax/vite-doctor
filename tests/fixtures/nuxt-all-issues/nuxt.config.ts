// @ts-nocheck
export default defineNuxtConfig({
  runtimeConfig: {
    public: {
      apiSecret: "public-secret",
    },
  },
  routeRules: {
    "/admin/**": { ssr: false },
  },
});
