import { join, resolve } from "pathe";
import {
  createRule,
  defineRulePack,
  type DoctorRule,
  type NuxtProjectInfo,
  type RuleContext,
} from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";

// Modules that mount the Better Auth handler at /api/auth/** themselves.
const HANDLER_MODULES = new Set(["@nuxtjs/better-auth"]);
const NUXT_CONFIG_FILES = [
  "nuxt.config.ts",
  "nuxt.config.js",
  "nuxt.config.mjs",
  "nuxt.config.mts",
];

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
        if (hasAuthHandler(nuxt)) return;
        const location = handlerLocation(ctx, nuxt);
        ctx.report(
          diagnostics.NUXT0003({
            why: "Nuxt Better Auth should expose the standard server/api/auth/[...all] handler.",
            fix: "Add server/api/auth/[...all].ts using the Better Auth Nuxt handler, or register @nuxtjs/better-auth, which mounts it.",
          }),
          {
            ruleId: "nuxt-better-auth/require-standard-auth-handler-mount",
            severity: "warn",
            category: "auth",
            file: location?.file ?? ctx.file.path,
            range: location?.range,
          },
        );
      },
    };
  },
});

function hasAuthHandler(nuxt: NuxtProjectInfo): boolean {
  if ((nuxt.modules ?? []).some((module) => HANDLER_MODULES.has(module.name))) return true;
  if (
    [...nuxt.serverDirs.api, ...nuxt.serverDirs.routes].some((file) =>
      /server\/api\/auth\/\[\.\.\.all\]\.[cm]?[jt]s$/.test(file),
    )
  )
    return true;
  return (nuxt.manifest?.serverHandlers ?? []).some(
    (handler) =>
      !handler.middleware && /^\/api\/auth\/(?:\*\*|\[\.\.\.\w*\])$/.test(handler.route ?? ""),
  );
}

/** The Better Auth server instance the handler should expose, else the Nuxt config. */
function handlerLocation(ctx: RuleContext, nuxt: NuxtProjectInfo) {
  const root = resolve(ctx.project.root, nuxt.layers[0]?.root ?? ".");
  for (const file of ctx.fs.glob("server/**/*.{ts,js,mts,mjs}", {
    cwd: root,
    exclude: ["**/node_modules/**"],
  })) {
    const text = ctx.fs.readText(file);
    const call = text?.match(/\bbetterAuth\s*\(/);
    if (text && call?.index !== undefined)
      return {
        file,
        range: ctx.helpers.rangeFromOffsets(file, text, call.index, call.index + call[0].length),
      };
  }
  const config = NUXT_CONFIG_FILES.map((name) => join(root, name)).find((file) =>
    ctx.fs.exists(file),
  );
  return config ? { file: config, range: undefined } : undefined;
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
