import { createRule, defineRulePack, type DoctorRule } from "@vue-doctor/core";
import { diagnostics } from "../diagnostics.js";

export const requireStandardAuthHandlerMount = createRule({
  meta: {
    id: "nuxt-better-auth/require-standard-auth-handler-mount",
    title: "Mount Better Auth at the standard catch-all route",
    category: "auth",
    severity: "warn",
    fixable: "suggestion",
    requires: { nuxt: true, crossFile: true },
  },
  create(ctx) {
    return {
      NuxtManifest(manifest) {
        const hasHandler = [...manifest.serverDirs.api, ...manifest.serverDirs.routes].some(
          (file) => /server\/api\/auth\/\[\.\.\.all\]\.[cm]?[jt]s$/.test(file),
        );
        if (hasHandler) return;
        ctx.report(
          diagnostics.NUXT0003.report({
            why: "Nuxt Better Auth should expose the standard server/api/auth/[...all] handler.",
            fix: "Add server/api/auth/[...all].ts using the Better Auth Nuxt handler.",
          }),
          {
            ruleId: "nuxt-better-auth/require-standard-auth-handler-mount",
            severity: "warn",
            category: "auth",
            file: ctx.file.path,
          },
        );
      },
    };
  },
});

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
