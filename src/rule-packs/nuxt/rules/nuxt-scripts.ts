import { createRule, defineRulePack, type DoctorRule } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";

type AnyNode = any;

export const noRawThirdPartyScriptTag = createRule({
  meta: {
    id: "nuxt-scripts/no-raw-third-party-script-tag",
    title: "Use Nuxt Scripts for third-party scripts",
    category: "scripts",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://scripts.nuxt.com/docs/getting-started#nuxt-script-features",
    requires: { template: true, nuxt: true },
  },
  create(ctx) {
    return {
      template: {
        element(node) {
          if (node.tag !== "script") return;
          const src = ctx.helpers.getStaticVueAttributeValue(node, "src");
          if (!src || src.startsWith("/") || src.startsWith("./")) return;
          ctx.helpers.report(
            ctx,
            node,
            diagnostics.NUXT0010({
              why: "Raw third-party script tags bypass Nuxt Scripts loading, consent, and trigger controls.",
              fix: "Load third-party scripts through Nuxt Scripts with an explicit trigger and consent policy.",
            }),
            {
              ruleId: "nuxt-scripts/no-raw-third-party-script-tag",
              severity: "warn",
              category: "scripts",
            },
          );
        },
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
    docsUrl: "https://scripts.nuxt.com/docs/guides/script-triggers#how-triggers-work",
    requires: { script: true, nuxt: true },
    prefilter: { calls: ["useHead"] },
  },
  create(ctx) {
    return {
      CallExpression(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "useHead")) return;
        const snippet = ctx.file.text.slice(node.start, node.end);
        if (!/script\s*:/.test(snippet) || !/https?:\/\//.test(snippet)) return;
        ctx.helpers.report(
          ctx,
          node,
          diagnostics.NUXT0012({
            why: "Third-party scripts loaded through useHead bypass Nuxt Scripts controls.",
            fix: "Use Nuxt Scripts with an explicit trigger and consent policy.",
          }),
          {
            ruleId: "nuxt-scripts/no-third-party-usehead-script",
            severity: "warn",
            category: "scripts",
          },
        );
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
    docsUrl: "https://scripts.nuxt.com/docs/guides/script-triggers#how-triggers-work",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!/nuxt\.config\.[cm]?[jt]s$/.test(ctx.file.relativePath)) return;
    return {
      Property(node: AnyNode) {
        const key = node.key?.name ?? node.key?.value;
        if (key !== "script") return;
        const snippet = ctx.file.text.slice(node.start, node.end);
        if (!/https?:\/\//.test(snippet)) return;
        ctx.helpers.report(
          ctx,
          node,
          diagnostics.NUXT0011({
            why: "Third-party scripts configured in app.head bypass Nuxt Scripts loading controls.",
            fix: "Move this script to Nuxt Scripts configuration or a registry script.",
          }),
          {
            ruleId: "nuxt-scripts/no-third-party-config-script",
            severity: "warn",
            category: "scripts",
          },
        );
      },
    };
  },
});

export const rules: DoctorRule[] = [
  noRawThirdPartyScriptTag,
  noThirdPartyUseHeadScript,
  noThirdPartyConfigScript,
];

export const nuxtScriptsRulePack = defineRulePack({
  name: "vite-doctor/nuxt-scripts",
  version: "0.0.0",
  activation: { nuxt: ">=4", packages: ["@nuxt/scripts"], modules: ["@nuxt/scripts"] },
  rules,
  presets: { recommended: rules.map((rule) => rule.meta.id) },
});

export default nuxtScriptsRulePack;
