import { existsSync, readFileSync } from "node:fs";
import { join } from "pathe";
import { createRule, type DoctorRule, type RulePack } from "@vue-doctor/core";

type AnyNode = any;

export const requireUAppRoot = createRule({
  meta: {
    id: "nuxt-ui/require-uapp-root",
    title: "Use UApp when Nuxt UI app services are used",
    category: "ui",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    const usesAppService = /\b(useToast|useOverlay)\s*\(/.test(ctx.file.text);
    if (!usesAppService || projectHasUAppRoot(ctx.project.root) || /<\s*UApp\b/.test(ctx.file.text))
      return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Program") return;
        ctx.report({
          ruleId: "nuxt-ui/require-uapp-root",
          severity: "warn",
          category: "ui",
          file: ctx.file.path,
          range: ctx.range(node),
          message: "Nuxt UI toast and overlay services require a UApp root provider.",
          suggestion: "Wrap the app shell with <UApp> before using useToast() or useOverlay().",
        });
      },
    };
  },
});

export const rules: DoctorRule[] = [requireUAppRoot];

export const nuxtUiRulePack: RulePack = {
  name: "nuxt-doctor/nuxt-ui",
  version: "0.0.0",
  activation: { nuxt: ">=4", packages: ["@nuxt/ui"], modules: ["@nuxt/ui"] },
  rules,
  presets: { recommended: rules.map((rule) => rule.meta.id) },
};

export default nuxtUiRulePack;

function projectHasUAppRoot(root: string): boolean {
  return ["app/app.vue", "app.vue", "app/layouts/default.vue", "layouts/default.vue"].some(
    (file) => {
      const absolute = join(root, file);
      return existsSync(absolute) && /<\s*UApp\b/.test(readFileSync(absolute, "utf8"));
    },
  );
}
