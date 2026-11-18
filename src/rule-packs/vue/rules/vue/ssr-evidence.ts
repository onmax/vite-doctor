import { resolve } from "pathe";
import type { RuleContext } from "../../../../core/index.js";
import { projectWorkspacePackages } from "../../../../core/internal/applicability.js";
import { owningWorkspacePackage } from "../../../../core/internal/workspace-packages.js";
import { projectNuxtInventories } from "../../../../core/internal/workspace-nuxt.js";

/**
 * Why Doctor treats the Rule's file as Vue code that renders on a server, or `undefined` when it
 * has no such evidence or the file belongs to a Nuxt app, whose hydration Rules own it.
 *
 * Evidence comes from the file's workspace package in Project Inventory: its manifest, such as a
 * `./nuxt` export or an SSR renderer dependency, or a server-rendered workspace package that
 * depends on it. The Rule option `{ ssr: true }` or `{ ssr: false }` overrides it, for libraries
 * whose server-rendering consumers live outside the workspace.
 */
export function vueSsrEvidence(ctx: RuleContext): string | undefined {
  const packages = projectWorkspacePackages(ctx.project);
  const owner = packages.find(
    (item) => item.root === owningWorkspacePackage(packages, ctx.file.relativePath),
  );
  if (owner?.framework === "nuxt" || isInNuxtApp(ctx, owner?.root ?? ".")) return undefined;
  const option = (ctx.options as { ssr?: unknown } | undefined)?.ssr;
  if (option === false) return undefined;
  if (option === true) return "the Rule option ssr is true";
  if (owner?.ssr) return owner.ssr;
  // Legacy inventories may have no owner. An inventoried package without SSR evidence
  // can be a proven browser app, so never reintroduce the run-level evidence for it.
  if (!owner && ctx.project.framework !== "nuxt" && ctx.project.ssr)
    return "the project renders on the server";
  return undefined;
}

/**
 * Whether the Doctor Run itself is a Vue SSR project outside Nuxt. Rules that report any browser
 * global or random id in a file, not only render values, keep to this narrower evidence: in a
 * library they cannot tell whether a helper ever runs during a server render.
 */
export function isVueSsrRun(ctx: RuleContext): boolean {
  return ctx.project.framework !== "nuxt" && ctx.project.ssr;
}

/**
 * Whether the file sits in a Nuxt app or layer directory. A Nuxt app at the workspace root does not
 * own the workspace packages nested in it unless one of them is itself a layer.
 */
function isInNuxtApp(ctx: RuleContext, ownerRoot: string): boolean {
  const file = resolve(ctx.project.root, ctx.file.relativePath);
  const ownerDir = resolve(ctx.project.root, ownerRoot);
  return projectNuxtInventories(ctx.project).some((nuxt) =>
    [...nuxt.appRoots, ...nuxt.layers.map((layer) => layer.root)].some((root) => {
      const absolute = resolve(ctx.project.root, root);
      return isInside(file, absolute) && isInside(absolute, ownerDir);
    }),
  );
}

function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}
