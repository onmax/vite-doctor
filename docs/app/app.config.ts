// @ts-expect-error Nuxt provides defineAppConfig as an app config macro.
export default defineAppConfig({
  docus: { locale: "en", assistant: false },
  header: {
    title: "Nuxt Doctor",
    logo: {
      light: "/nuxt-doctor-logo.svg",
      dark: "/nuxt-doctor-logo.svg",
      alt: "Nuxt Doctor",
    },
  },
  navigation: { sub: false },
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
