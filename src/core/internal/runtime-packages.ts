import type { DoctorFramework, RuntimeGraph, RuntimePackageName } from "../primitives.js";

/** npm package names that install each runtime, the canonical name first. */
export const runtimePackageNames: Record<RuntimePackageName, string[]> = {
  nuxt: ["nuxt"],
  nitro: ["nitro", "nitropack"],
  h3: ["h3"],
  vue: ["vue"],
};

/** Frameworks whose packages run a runtime without declaring it, as Nitro and Nuxt run h3. */
export const runtimeProviders: Record<RuntimePackageName, DoctorFramework[]> = {
  nuxt: ["nuxt"],
  nitro: ["nitro", "nuxt"],
  h3: ["nitro", "nuxt"],
  vue: ["vue", "nuxt"],
};

/** Runtimes a package.json declares in any dependency field, peer dependencies included. */
export function declaredRuntimes(manifest: object | null): RuntimePackageName[] {
  const fields = manifest as Partial<Record<string, unknown>> | null;
  const names = new Set(
    ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].flatMap(
      (key) => {
        const value = fields?.[key];
        return value && typeof value === "object" ? Object.keys(value) : [];
      },
    ),
  );
  return (Object.keys(runtimePackageNames) as RuntimePackageName[]).filter((runtime) =>
    runtimePackageNames[runtime].some((name) => names.has(name)),
  );
}

/**
 * Runtimes whose resolution decides which Rules apply to a package: those its framework runs,
 * and an h3 the package runs itself.
 */
export function governingRuntimes(
  framework: DoctorFramework,
  graph: RuntimeGraph | undefined,
): RuntimePackageName[] {
  const runtimes: RuntimePackageName[] =
    framework === "nuxt"
      ? ["nuxt", "nitro", "h3"]
      : framework === "nitro"
        ? ["nitro", "h3"]
        : framework === "vue"
          ? ["vue"]
          : [];
  if (!runtimes.includes("h3") && graph?.packages.h3?.owner === "project") runtimes.push("h3");
  return runtimes;
}
