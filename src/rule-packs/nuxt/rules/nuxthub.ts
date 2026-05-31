import { createRule, defineRulePack, type DoctorRule } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";

type AnyNode = any;

export const noPersonalizedCachedHandler = createRule({
  meta: {
    id: "nuxthub/no-personalized-cached-handler",
    title: "Do not cache personalized handlers without varying",
    category: "cache",
    severity: "error",
    fixable: "suggestion",
    docsUrl: "https://hub.nuxt.com/docs/features/cache#when-to-use-cache",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "cachedEventHandler")) return;
        const snippet = ctx.file.text.slice(node.start, node.end);
        if (!/(getUserSession|getCookie|getHeader|authorization|tenant|user)/i.test(snippet))
          return;
        if (/(varies|headers|group|name|getKey)/i.test(snippet)) return;
        ctx.helpers.report(
          ctx,
          node,
          diagnostics.NUXT0062({
            why: "This cached handler appears to depend on user, tenant, cookie, or auth state.",
            fix: "Avoid caching personalized responses or include an explicit cache key/vary strategy.",
          }),
          {
            ruleId: "nuxthub/no-personalized-cached-handler",
            severity: "error",
            category: "cache",
          },
        );
      },
    };
  },
});

export const preferCachedEventHandler = createRule({
  meta: {
    id: "nuxthub/prefer-cached-event-handler",
    title: "Cache expensive public server handlers",
    category: "cache",
    severity: "info",
    fixable: "suggestion",
    docsUrl: "https://hub.nuxt.com/docs/features/cache#when-to-use-cache",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Program") return;
        if (/cachedEventHandler/.test(ctx.file.text)) return;
        if (!/(await\s+\$fetch|queryCollection|hubDatabase|hubKV|readBody)/.test(ctx.file.text))
          return;
        if (/(getUserSession|getCookie|getHeader|authorization|tenant|user)/i.test(ctx.file.text))
          return;
        ctx.helpers.report(
          ctx,
          node,
          diagnostics.NUXT0063({
            why: "This public-looking server handler does expensive work and may be cacheable.",
            fix: "Consider cachedEventHandler() with route rules when the response is public.",
          }),
          {
            ruleId: "nuxthub/prefer-cached-event-handler",
            severity: "info",
            category: "cache",
          },
        );
      },
    };
  },
});

export const rules: DoctorRule[] = [noPersonalizedCachedHandler, preferCachedEventHandler];

export const nuxtHubRulePack = defineRulePack({
  name: "vite-doctor/nuxthub",
  version: "0.0.0",
  activation: { nuxt: ">=4", packages: ["nuxthub"], modules: ["nuxthub"] },
  rules,
  presets: { recommended: rules.map((rule) => rule.meta.id) },
});

export default nuxtHubRulePack;
