import type { NuxtProjectInfo, ProjectInfo } from "../primitives.js";

const views = new WeakMap<ProjectInfo, Map<string, ProjectInfo>>();
const viewRoots = new WeakMap<ProjectInfo, string>();

/**
 * `project` as Rules see it from workspace package `packageRoot`. A Nuxt workspace package with
 * its own Nuxt Project Inventory replaces the Nuxt fields, and a package that resolves its own
 * runtimes replaces the runtime graph; everything else, including writes such as `evidenceGaps`,
 * stays on the Doctor Run's project.
 */
export function workspaceProjectView(project: ProjectInfo, packageRoot: string): ProjectInfo {
  const inventory = project.workspaceNuxt?.find((item) => item.root === packageRoot);
  const runtimeGraph = project.workspaceRuntimeGraphs?.[packageRoot];
  if (!inventory && !runtimeGraph) return project;
  let cached = views.get(project);
  if (!cached) views.set(project, (cached = new Map()));
  const existing = cached.get(packageRoot);
  if (existing) return existing;
  const overrides: Partial<ProjectInfo> = inventory
    ? {
        nuxt: inventory.nuxt,
        ssr: inventory.nuxt.ssr !== false,
        nuxtVersion: inventory.nuxtVersion,
        nuxtModuleDefinitions: inventory.nuxtModuleDefinitions,
        runtimeGraph: inventory.runtimeGraph,
        nuxtCompatibility: inventory.nuxtCompatibility,
      }
    : { runtimeGraph };
  const view = new Proxy(project, {
    get(target, key, receiver) {
      return Object.hasOwn(overrides, key)
        ? overrides[key as keyof ProjectInfo]
        : Reflect.get(target, key, receiver);
    },
    has(target, key) {
      return Object.hasOwn(overrides, key) || Reflect.has(target, key);
    },
    ownKeys(target) {
      return [...new Set([...Reflect.ownKeys(target), ...Reflect.ownKeys(overrides)])];
    },
    getOwnPropertyDescriptor(target, key) {
      if (!Object.hasOwn(overrides, key)) return Reflect.getOwnPropertyDescriptor(target, key);
      return {
        configurable: true,
        enumerable: true,
        writable: false,
        value: overrides[key as keyof ProjectInfo],
      };
    },
  });
  cached.set(packageRoot, view);
  viewRoots.set(view, packageRoot);
  return view;
}

/** The workspace package root of a package view, or `undefined` for the run's project. */
export function workspaceViewRoot(project: ProjectInfo): string | undefined {
  return viewRoots.get(project);
}

/** Workspace package roots that read their own Nuxt Project Inventory. */
export function workspaceNuxtRoots(project: ProjectInfo): string[] {
  return (project.workspaceNuxt ?? []).map((item) => item.root);
}

/** Workspace package roots whose project view differs from the Doctor Run's project. */
export function workspaceViewRoots(project: ProjectInfo): string[] {
  return [...workspaceNuxtRoots(project), ...Object.keys(project.workspaceRuntimeGraphs ?? {})];
}

/** Every Nuxt Project Inventory in the Doctor Run, the run owner's first. */
export function projectNuxtInventories(project: ProjectInfo): NuxtProjectInfo[] {
  return [
    ...(project.nuxt ? [project.nuxt] : []),
    ...(project.workspaceNuxt ?? []).map((item) => item.nuxt),
  ];
}
