// @ts-expect-error Nuxt provides defineAppConfig as an app config macro.
export default defineAppConfig({
  docus: { locale: "en", assistant: false },
  header: {
    title: "Vue Doctor",
    logo: { light: "/vue-doctor-logo.svg", dark: "/vue-doctor-logo.svg" },
  },
  navigation: { sub: "header" },
  github: {
    url: "https://github.com/onmax/nuxt-doctor",
    branch: "main",
    rootDir: "docs",
  },
  assistant: { enabled: false, explainWithAi: false },
  toc: { title: "On This Page" },
  ui: {
    colors: { primary: "emerald", secondary: "sky", neutral: "zinc" },
  },
});
