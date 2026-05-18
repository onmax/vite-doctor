import { createRule, defineRulePack, type DoctorRule } from "@vue-doctor/core";
import { diagnostics } from "../diagnostics.js";

type AnyNode = any;

export const noQueryContentLegacyApi = createRule({
  meta: {
    id: "nuxt-content/no-querycontent-legacy-api",
    title: "Use queryCollection instead of queryContent",
    category: "content",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "queryContent")) return;
        ctx.helpers.report(
          ctx,
          node,
          diagnostics.NUXT0005.report({
            why: "queryContent() is the legacy Nuxt Content API.",
            fix: "Use queryCollection() with a declared collection.",
          }),
          {
            ruleId: "nuxt-content/no-querycontent-legacy-api",
            severity: "warn",
            category: "content",
          },
        );
      },
    };
  },
});

export const rules: DoctorRule[] = [noQueryContentLegacyApi];

export const nuxtContentRulePack = defineRulePack({
  name: "vite-doctor/nuxt-content",
  version: "0.0.0",
  activation: { nuxt: ">=4", packages: ["@nuxt/content"], modules: ["@nuxt/content"] },
  rules,
  presets: { recommended: rules.map((rule) => rule.meta.id) },
});

export default nuxtContentRulePack;
