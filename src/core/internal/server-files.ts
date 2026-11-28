import type { DoctorFramework, RuleContext } from "../primitives.js";
import { owningWorkspacePackage } from "./workspace-packages.js";

/**
 * The file's path inside the workspace package that owns it, and that package's framework. A
 * workspace mixes frameworks, so the run's framework does not say whether a file is a server file.
 */
function owningPackageFile(ctx: RuleContext): { path: string; framework: DoctorFramework } {
  const path = ctx.file.relativePath.replace(/\\/g, "/");
  const packages = ctx.project.workspacePackages;
  if (!packages?.length) return { path, framework: ctx.project.framework };
  const root = owningWorkspacePackage(packages, path);
  const owner = packages.find((item) => item.root === root);
  return {
    path: root === "." ? path : path.slice(root.length + 1),
    framework: owner?.framework ?? ctx.project.framework,
  };
}

export function isNitroRouteFile(ctx: RuleContext) {
  const { path, framework } = owningPackageFile(ctx);
  if (framework === "nuxt") return /^(?:app\/)?server\/(?:api|routes)\/.+\.[cm]?[jt]s$/.test(path);
  return framework === "nitro" && /^(?:server\/)?(?:api|routes)\/.+\.[cm]?[jt]s$/.test(path);
}

export function isNitroServerFile(ctx: RuleContext) {
  const { path, framework } = owningPackageFile(ctx);
  if (framework === "nuxt") return ctx.helpers.isNuxtServerFile(path);
  return (
    framework === "nitro" &&
    (/^(?:server\/)?(?:api|routes)\/.+\.[cm]?[jt]s$/.test(path) ||
      /^(?:server\/)?middleware\/.+\.[cm]?[jt]s$/.test(path))
  );
}
