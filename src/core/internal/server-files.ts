import type { RuleContext } from "../primitives.js";

export function isNitroRouteFile(ctx: RuleContext) {
  const path = ctx.file.relativePath.replace(/\\/g, "/");
  if (ctx.project.framework === "nuxt")
    return /^(?:app\/)?server\/(?:api|routes)\/.+\.[cm]?[jt]s$/.test(path);
  return (
    ctx.project.framework === "nitro" && /^(?:server\/)?(?:api|routes)\/.+\.[cm]?[jt]s$/.test(path)
  );
}

export function isNitroServerFile(ctx: RuleContext) {
  const path = ctx.file.relativePath.replace(/\\/g, "/");
  return (
    (ctx.project.framework === "nuxt" && ctx.helpers.isNuxtServerFile(path)) ||
    (ctx.project.framework === "nitro" &&
      (isNitroRouteFile(ctx) || /^(?:server\/)?middleware\/.+\.[cm]?[jt]s$/.test(path)))
  );
}
