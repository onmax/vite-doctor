import type { NuxtProjectInfo, ProjectInfo } from "../primitives.js";
import { resolve } from "pathe";

const views = new WeakMap<ProjectInfo, Map<string, ProjectInfo>>();

/**
 * `project` as Rules see it from workspace package `packageRoot`. A Nuxt workspace package with
 * its own Nuxt Project Inventory replaces the Nuxt fields; everything else, including writes such
 * as `evidenceGaps`, stays on the Doctor Run's project.
 */
export function workspaceProjectView(project: ProjectInfo, packageRoot: string): ProjectInfo {
  const inventory = project.workspaceNuxt?.find((item) => item.root === packageRoot);
  if (!inventory) return project;
  let cached = views.get(project);
  if (!cached) views.set(project, (cached = new Map()));
  const existing = cached.get(packageRoot);
  if (existing) return existing;
  const overrides: Partial<ProjectInfo> = {
    root: resolve(project.root, packageRoot),
    nuxt: inventory.nuxt,
    nuxtVersion: inventory.nuxtVersion,
    nuxtModuleDefinitions: inventory.nuxtModuleDefinitions,
    runtimeGraph: inventory.runtimeGraph,
    nuxtCompatibility: inventory.nuxtCompatibility,
  };
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
  return view;
}

/** Workspace package roots that read their own Nuxt Project Inventory. */
export function workspaceNuxtRoots(project: ProjectInfo): string[] {
  return (project.workspaceNuxt ?? []).map((item) => item.root);
}

/** Every Nuxt Project Inventory in the Doctor Run, the run owner's first. */
export function projectNuxtInventories(project: ProjectInfo): NuxtProjectInfo[] {
  return [
    ...(project.nuxt ? [project.nuxt] : []),
    ...(project.workspaceNuxt ?? []).map((item) => item.nuxt),
  ];
}
