import { resolve } from "pathe";
import type { NuxtProjectInfo, RuleContext } from "../../../../core/index.js";
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
export function vueSsrEvidence(
  ctx: RuleContext,
  relativePath = ctx.file.relativePath,
): string | undefined {
  const owner = owningPackage(ctx, relativePath);
  if (owner?.framework === "nuxt" || nuxtAppOf(ctx, relativePath, owner?.root ?? "."))
    return undefined;
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
 * Why Doctor treats the SFC at `relativePath` as rendered on the server and then hydrated, in a
 * Nuxt app or in other Vue code, or `undefined` without that evidence. A Nuxt app hydrates unless
 * `ssr` is false, but a route rule can turn SSR off for routes Doctor cannot map to components, so
 * an app with route rules Doctor cannot read, or with one that sets `ssr: false`, has no evidence.
 */
export function hydrationEvidence(
  ctx: RuleContext,
  relativePath: string,
  appsWithPossibleInlineSsrOptOut: ReadonlySet<NuxtProjectInfo>,
): string | undefined {
  const nuxt = hydrationNuxtApp(ctx, relativePath);
  if (!nuxt) return vueSsrEvidence(ctx, relativePath);
  if (
    nuxt.hydrationSsr !== true ||
    appsWithPossibleInlineSsrOptOut.has(nuxt) ||
    !routeRulesKeepSsr(nuxt.routeRules)
  )
    return undefined;
  return "the Nuxt app enables SSR and has no known route-level SSR opt-out";
}

export function hydrationNuxtApp(
  ctx: RuleContext,
  relativePath: string,
): NuxtProjectInfo | undefined {
  return nuxtAppOf(ctx, relativePath, owningPackage(ctx, relativePath)?.root ?? ".");
}

function routeRulesKeepSsr(rules: Record<string, unknown> | undefined): boolean {
  if (!rules) return true;
  // Without the build manifest Doctor only knows that nuxt.config mentions `routeRules`.
  if (rules.__staticDetection) return false;
  return Object.values(rules).every(
    (rule) =>
      typeof rule !== "object" || rule === null || (rule as { ssr?: unknown }).ssr !== false,
  );
}

function owningPackage(ctx: RuleContext, relativePath: string) {
  const packages = projectWorkspacePackages(ctx.project);
  const root = owningWorkspacePackage(packages, relativePath);
  return packages.find((item) => item.root === root);
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
 * The Nuxt app whose app or layer directory holds the file. A Nuxt app at the workspace root does
 * not own the workspace packages nested in it unless one of them is itself a layer.
 */
function nuxtAppOf(
  ctx: RuleContext,
  relativePath: string,
  ownerRoot: string,
): NuxtProjectInfo | undefined {
  const file = resolve(ctx.project.root, relativePath);
  const ownerDir = resolve(ctx.project.root, ownerRoot);
  return projectNuxtInventories(ctx.project).find((nuxt) =>
    [...nuxt.appRoots, ...nuxt.layers.map((layer) => layer.root)].some((root) => {
      const absolute = resolve(ctx.project.root, root);
      return isInside(file, absolute) && isInside(absolute, ownerDir);
    }),
  );
}

function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}
