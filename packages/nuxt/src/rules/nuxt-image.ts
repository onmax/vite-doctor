import { createRule, type DoctorRule, type RulePack } from "@vue-doctor/core";

type AnyNode = any;

export const preferNuxtImg = createRule({
  meta: {
    id: "nuxt-image/prefer-nuxtimg",
    title: "Use NuxtImg for app images",
    category: "images",
    severity: "info",
    fixable: "suggestion",
    requires: { template: true, nuxt: true },
  },
  create(ctx) {
    return {
      TemplateNode(node: AnyNode) {
        if (node.type !== "VElement" || node.rawName !== "img") return;
        ctx.helpers.report(ctx, node, {
          ruleId: "nuxt-image/prefer-nuxtimg",
          severity: "info",
          category: "images",
          message: "Raw <img> misses Nuxt Image optimization and responsive providers.",
          suggestion: "Use <NuxtImg> for application images.",
        });
      },
    };
  },
});

export const requireImageAlt = createRule({
  meta: {
    id: "nuxt-image/require-alt",
    title: "Provide alt text for Nuxt images",
    category: "images",
    severity: "error",
    fixable: "suggestion",
    requires: { template: true, nuxt: true },
  },
  create(ctx) {
    return {
      TemplateNode(node: AnyNode) {
        if (node.type !== "VElement" || !["NuxtImg", "NuxtPicture", "img"].includes(node.rawName))
          return;
        if (
          ctx.helpers.hasVueAttribute(node, "alt") ||
          ctx.helpers.hasVueDirective(node, "bind", "alt")
        )
          return;
        ctx.helpers.report(ctx, node, {
          ruleId: "nuxt-image/require-alt",
          severity: "error",
          category: "images",
          message: "Images need alt text or an explicit empty alt for decorative images.",
          suggestion: "Add alt text that describes the image.",
        });
      },
    };
  },
});

export const preferResponsiveDimensions = createRule({
  meta: {
    id: "nuxt-image/prefer-responsive-dimensions",
    title: "Provide image dimensions or sizes",
    category: "images",
    severity: "warn",
    fixable: "suggestion",
    requires: { template: true, nuxt: true },
  },
  create(ctx) {
    return {
      TemplateNode(node: AnyNode) {
        if (node.type !== "VElement" || !["NuxtImg", "NuxtPicture"].includes(node.rawName)) return;
        const hasSizing =
          ctx.helpers.hasVueAttribute(node, "width") ||
          ctx.helpers.hasVueAttribute(node, "height") ||
          ctx.helpers.hasVueAttribute(node, "sizes") ||
          ctx.helpers.hasVueDirective(node, "bind", "sizes");
        if (hasSizing) return;
        ctx.helpers.report(ctx, node, {
          ruleId: "nuxt-image/prefer-responsive-dimensions",
          severity: "warn",
          category: "images",
          message: "Nuxt images should declare dimensions or responsive sizes.",
          suggestion: "Add width/height for fixed images or sizes for responsive images.",
        });
      },
    };
  },
});

export const preferNuxtPictureForFormats = createRule({
  meta: {
    id: "nuxt-image/prefer-nuxtpicture-for-formats",
    title: "Use NuxtPicture for format negotiation",
    category: "images",
    severity: "info",
    fixable: "suggestion",
    requires: { template: true, nuxt: true },
  },
  create(ctx) {
    return {
      TemplateNode(node: AnyNode) {
        if (node.type !== "VElement" || node.rawName !== "NuxtImg") return;
        const format = ctx.helpers.getStaticVueAttributeValue(node, "format");
        if (!format || !/(webp|avif)/i.test(format)) return;
        ctx.helpers.report(ctx, node, {
          ruleId: "nuxt-image/prefer-nuxtpicture-for-formats",
          severity: "info",
          category: "images",
          message: "Format negotiation is clearer with <NuxtPicture>.",
          suggestion: "Use <NuxtPicture> when serving modern formats with fallbacks.",
        });
      },
    };
  },
});

export const rules: DoctorRule[] = [
  preferNuxtImg,
  requireImageAlt,
  preferResponsiveDimensions,
  preferNuxtPictureForFormats,
];

export const nuxtImageRulePack: RulePack = {
  name: "nuxt-doctor/nuxt-image",
  version: "0.0.0",
  activation: { nuxt: ">=4", packages: ["@nuxt/image"], modules: ["@nuxt/image"] },
  rules,
  presets: { recommended: rules.map((rule) => rule.meta.id) },
};

export default nuxtImageRulePack;
