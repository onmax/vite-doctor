import { relative } from "pathe";
import type { RuleContext } from "../../../core/index.js";
import { projectWorkspacePackages } from "../../../core/internal/applicability.js";
import { owningWorkspacePackage } from "../../../core/internal/workspace-packages.js";

/** The root of the workspace package that owns the file, relative to the project root. */
export function ownerRoot(ctx: RuleContext): string {
  return owningWorkspacePackage(
    projectWorkspacePackages(ctx.project),
    relative(ctx.project.root, ctx.file.path),
  );
}

/** Whether the file's workspace package depends on, or its Nuxt config installs, one of `names`. */
export function ownerUses(ctx: RuleContext, names: readonly string[]): boolean {
  const root = ownerRoot(ctx);
  const owner = projectWorkspacePackages(ctx.project).find((item) => item.root === root);
  const modules = (ctx.project.nuxt?.modules ?? []).map((module) => module.name);
  return names.some((name) => (owner && name in owner.packages) || modules.includes(name));
}
