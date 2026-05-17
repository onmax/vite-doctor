import { createRule, defineRulePack, type DoctorRule } from "@vue-doctor/core";

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
        ctx.report({
          ruleId: "nuxt-better-auth/require-standard-auth-handler-mount",
          severity: "warn",
          category: "auth",
          file: ctx.file.path,
          message: "Nuxt Better Auth should expose the standard server/api/auth/[...all] handler.",
          suggestion: "Add server/api/auth/[...all].ts using the Better Auth Nuxt handler.",
        });
      },
    };
  },
});

export const rules: DoctorRule[] = [requireStandardAuthHandlerMount];

export const nuxtBetterAuthRulePack = defineRulePack({
  name: "nuxt-doctor/nuxt-better-auth",
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
