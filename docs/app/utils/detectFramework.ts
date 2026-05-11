export type Framework = "vue" | "nuxt";

export function detectFramework(packageJsonContents: string): Framework {
  try {
    const pkg = JSON.parse(packageJsonContents);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.nuxt || deps["nuxt-edge"] || deps.nuxt3) return "nuxt";
    return "vue";
  } catch {
    return "vue";
  }
}
