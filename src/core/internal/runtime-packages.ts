import { createRequire } from "node:module";
import type {
  DoctorFramework,
  ProjectInfo,
  RuntimeGraph,
  RuntimePackageName,
} from "../primitives.js";
import { workspaceProjectView } from "./workspace-nuxt.js";

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

/**
 * Runtimes a package.json declares. A dependency or required peer always counts. An optional peer
 * or optional dependency counts only when it resolves from `manifestPath`, since a library with an
 * uninstalled optional `h3` peer does not run h3; without `manifestPath` it never counts.
 */
export function declaredRuntimes(
  manifest: object | null,
  manifestPath?: string,
): RuntimePackageName[] {
  const fields = manifest as Partial<Record<string, unknown>> | null;
  const keys = (key: string) => {
    const value = fields?.[key];
    return value && typeof value === "object" ? Object.keys(value) : [];
  };
  const peerMeta = fields?.peerDependenciesMeta as
    | Partial<Record<string, { optional?: unknown }>>
    | undefined;
  const required = new Set([
    ...keys("dependencies"),
    ...keys("devDependencies"),
    ...keys("peerDependencies").filter((name) => peerMeta?.[name]?.optional !== true),
  ]);
  const optional = new Set(
    [...keys("optionalDependencies"), ...keys("peerDependencies")].filter(
      (name) => !required.has(name),
    ),
  );
  const declares = (name: string) =>
    required.has(name) ||
    (optional.has(name) && manifestPath !== undefined && resolvesFrom(manifestPath, name));
  return (Object.keys(runtimePackageNames) as RuntimePackageName[]).filter((runtime) =>
    runtimePackageNames[runtime].some(declares),
  );
}

function resolvesFrom(manifestPath: string, name: string): boolean {
  const require = createRequire(manifestPath);
  for (const request of [`${name}/package.json`, name]) {
    try {
      require.resolve(request);
      return true;
    } catch {}
  }
  return false;
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

export function unresolvedRuntimeInventory(project: ProjectInfo) {
  const scopes = project.workspacePackages ?? [{ root: ".", framework: project.framework }];
  return scopes.flatMap(({ root, framework }) => {
    const view = workspaceProjectView(project, root);
    if (view === project && root !== (project.runtimeGraphRoot ?? ".")) return [];
    const graph = view.runtimeGraph;
    const unresolved = [
      ...governingRuntimes(framework, graph).map((runtime) => graph?.packages[runtime]),
      graph?.directH3,
    ].filter((item) => item?.state === "unknown");
    const compatibility = framework === "nuxt" ? view.nuxtCompatibility : undefined;
    return unresolved.length || compatibility?.state === "unknown"
      ? [{ root, unresolved, compatibility, manifestPath: view.nuxt?.manifestPath }]
      : [];
  });
}
