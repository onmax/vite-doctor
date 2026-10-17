import { join, resolve } from "pathe";
import {
  createRule,
  defineRulePack,
  type DoctorRule,
  type NuxtProjectInfo,
  type RuleContext,
} from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";

// Modules that mount the Better Auth handler at /api/auth/** themselves; nuxt-better-auth does it
// through its nitro-better-auth Nitro module.
const HANDLER_MODULE = /["'](?:@nuxtjs\/better-auth|nuxt-better-auth)["']/;
const SCRIPT = "{ts,js,mts,mjs,cts,cjs}";
// Where Better Auth's CLI looks for the auth instance, plus the Nitro server directory.
const INSTANCE_GLOBS = [
  `server/**/*.${SCRIPT}`,
  ...["", "app/", "src/"].flatMap((dir) => [
    `${dir}{lib,utils}/**/*.${SCRIPT}`,
    `${dir}auth.${SCRIPT}`,
  ]),
];
const NUXT_CONFIG_FILES = ["ts", "mts", "cts", "js", "mjs", "cjs"].map(
  (extension) => `nuxt.config.${extension}`,
);
const AUTH_CATCH_ALL_ROUTE = /^\/api\/auth\/(?:\*\*(?::\w+)?|\[\.\.\.\w*\])$/;

export const requireStandardAuthHandlerMount = createRule({
  meta: {
    id: "nuxt-better-auth/require-standard-auth-handler-mount",
    title: "Mount Better Auth at the standard catch-all route",
    category: "auth",
    severity: "warn",
    fixable: "suggestion",
    execution: "manifest",
    requires: { nuxt: true, crossFile: true },
  },
  create(ctx) {
    return {
      NuxtManifest(nuxt) {
        const root = resolve(ctx.project.root, nuxt.layers[0]?.root ?? ".");
        // An installed Better Auth package is not evidence: without a server instance there is
        // nothing to mount.
        const instance = findAuthInstance(ctx, root);
        if (!instance || hasAuthHandler(ctx, nuxt, root)) return;
        ctx.report(
          diagnostics.NUXT0003({
            why: "Nuxt Better Auth should expose the standard server/api/auth/[...all] handler.",
            fix: "Add server/api/auth/[...all].ts using the Better Auth Nuxt handler, or register @nuxtjs/better-auth, which mounts it.",
          }),
          {
            ruleId: "nuxt-better-auth/require-standard-auth-handler-mount",
            severity: "warn",
            category: "auth",
            file: instance.file,
            range: instance.range,
          },
        );
      },
    };
  },
});

function hasAuthHandler(ctx: RuleContext, nuxt: NuxtProjectInfo, root: string): boolean {
  if (
    [...nuxt.serverDirs.api, ...nuxt.serverDirs.routes].some((file) =>
      /server\/api\/auth\/\[\.\.\.all\]\.[cm]?[jt]s$/.test(file),
    )
  )
    return true;
  const manifest = nuxt.manifest?.isCurrent ? nuxt.manifest : undefined;
  if (
    [...(manifest?.serverHandlers ?? []), ...(manifest?.resolvedServerHandlers ?? [])].some(
      (handler) => !handler.middleware && AUTH_CATCH_ALL_ROUTE.test(handler.route ?? ""),
    )
  )
    return true;
  const layerRoots = [root, ...nuxt.layers.map((layer) => resolve(ctx.project.root, layer.root))];
  return [...new Set(layerRoots)].some((layer) =>
    NUXT_CONFIG_FILES.some((name) => HANDLER_MODULE.test(ctx.fs.readText(join(layer, name)) ?? "")),
  );
}

/** The first `betterAuth()` call, the server instance whose handler must be mounted. */
function findAuthInstance(ctx: RuleContext, root: string) {
  for (const pattern of INSTANCE_GLOBS) {
    for (const file of ctx.fs.glob(pattern, { cwd: root, exclude: ["**/node_modules/**"] })) {
      const text = ctx.fs.readText(file);
      const call = text?.match(/\bbetterAuth\s*\(/);
      if (text && call?.index !== undefined)
        return {
          file,
          range: ctx.helpers.rangeFromOffsets(file, text, call.index, call.index + call[0].length),
        };
    }
  }
  return undefined;
}

export const rules: DoctorRule[] = [requireStandardAuthHandlerMount];

export const nuxtBetterAuthRulePack = defineRulePack({
  name: "vite-doctor/nuxt-better-auth",
  version: "0.0.0",
  activation: {
    nuxt: ">=4",
    packages: ["better-auth", "nuxt-better-auth"],
    modules: ["nuxt-better-auth"],
  },
  rules,
  presets: { recommended: rules.map((rule) => rule.meta.id) },
});

export default nuxtBetterAuthRulePack;
