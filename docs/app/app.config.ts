// @ts-expect-error Nuxt provides defineAppConfig as an app config macro.
export default defineAppConfig({
  docus: { locale: "en", assistant: false },
  header: {
    title: "Vite Doctor",
    logo: {
      light: "/doctor-icon.png",
      dark: "/doctor-icon.png",
      alt: "Vite Doctor",
    },
  },
  navigation: { sub: false },
  socials: {
    x: "https://x.com/_onmax",
  },
  github: {
    url: "https://github.com/onmax/vite-doctor",
    branch: "main",
    rootDir: "docs",
  },
  assistant: { enabled: false, explainWithAi: false },
  toc: { title: "On This Page" },
  ui: {
    colors: { primary: "emerald", secondary: "sky", neutral: "zinc" },
  },
});
