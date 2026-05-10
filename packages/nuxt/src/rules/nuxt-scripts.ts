import { createRule, type DoctorRule, type RulePack } from "@vue-doctor/core";

type AnyNode = any;

export const noRawThirdPartyScriptTag = createRule({
  meta: {
    id: "nuxt-scripts/no-raw-third-party-script-tag",
    title: "Use Nuxt Scripts for third-party scripts",
    category: "scripts",
    severity: "warn",
    fixable: "suggestion",
    requires: { template: true, nuxt: true },
  },
  create(ctx) {
    return {
      TemplateNode(node: AnyNode) {
        if (node.type !== "VElement" || node.rawName !== "script") return;
        const src = (node.startTag?.attributes ?? []).find(
          (attr: AnyNode) => !attr.directive && attr.key?.name === "src",
        )?.value?.value;
        if (!src || String(src).startsWith("/") || String(src).startsWith("./")) return;
        ctx.helpers.report(ctx, node, {
          ruleId: "nuxt-scripts/no-raw-third-party-script-tag",
          severity: "warn",
          category: "scripts",
          message:
            "Raw third-party script tags bypass Nuxt Scripts loading, consent, and trigger controls.",
          suggestion:
            "Load third-party scripts through Nuxt Scripts with an explicit trigger and consent policy.",
        });
      },
    };
  },
});

export const noThirdPartyUseHeadScript = createRule({
  meta: {
    id: "nuxt-scripts/no-third-party-usehead-script",
    title: "Use Nuxt Scripts instead of useHead for third-party scripts",
    category: "scripts",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "useHead")) return;
        const snippet = ctx.file.text.slice(node.start, node.end);
        if (!/script\s*:/.test(snippet) || !/https?:\/\//.test(snippet)) return;
        ctx.helpers.report(ctx, node, {
          ruleId: "nuxt-scripts/no-third-party-usehead-script",
          severity: "warn",
          category: "scripts",
          message: "Third-party scripts loaded through useHead bypass Nuxt Scripts controls.",
          suggestion: "Use Nuxt Scripts with an explicit trigger and consent policy.",
        });
      },
    };
  },
});

export const noThirdPartyConfigScript = createRule({
  meta: {
    id: "nuxt-scripts/no-third-party-config-script",
    title: "Use Nuxt Scripts instead of raw app.head scripts",
    category: "scripts",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!/nuxt\.config\.[cm]?[jt]s$/.test(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Property") return;
        const key = node.key?.name ?? node.key?.value;
        if (key !== "script") return;
        const snippet = ctx.file.text.slice(node.start, node.end);
        if (!/https?:\/\//.test(snippet)) return;
        ctx.helpers.report(ctx, node, {
          ruleId: "nuxt-scripts/no-third-party-config-script",
          severity: "warn",
          category: "scripts",
          message:
            "Third-party scripts configured in app.head bypass Nuxt Scripts loading controls.",
          suggestion: "Move this script to Nuxt Scripts configuration or a registry script.",
        });
      },
    };
  },
});

export const rules: DoctorRule[] = [
  noRawThirdPartyScriptTag,
  noThirdPartyUseHeadScript,
  noThirdPartyConfigScript,
];

export const nuxtScriptsRulePack: RulePack = {
  name: "nuxt-doctor/nuxt-scripts",
  version: "0.0.0",
  activation: { nuxt: ">=4", packages: ["@nuxt/scripts"], modules: ["@nuxt/scripts"] },
  rules,
  presets: { recommended: rules.map((rule) => rule.meta.id) },
};

export default nuxtScriptsRulePack;
