import { createRule, defineRulePack, type DoctorRule } from "@vue-doctor/core";
import { diagnostics } from "../diagnostics.js";

type AnyNode = any;

export const preferNuxtImg = createRule({
  meta: {
    id: "nuxt-image/prefer-nuxtimg",
    title: "Use NuxtImg for app images",
    category: "images",
    severity: "info",
    fixable: "suggestion",
    docsUrl: "https://image.nuxt.com/usage/nuxt-img#usage",
    requires: { template: true, nuxt: true },
  },
  create(ctx) {
    return {
      TemplateNode(node: AnyNode) {
        if (node.type !== "VElement" || node.rawName !== "img") return;
        ctx.helpers.report(
          ctx,
          node,
          diagnostics.NUXT0006({
            why: "Raw <img> misses Nuxt Image optimization and responsive providers.",
            fix: "Use <NuxtImg> for application images.",
          }),
          {
            ruleId: "nuxt-image/prefer-nuxtimg",
            severity: "info",
            category: "images",
          },
        );
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
    docsUrl: "https://image.nuxt.com/usage/nuxt-img#alt",
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
        ctx.helpers.report(
          ctx,
          node,
          diagnostics.NUXT0009({
            why: "Images need alt text or an explicit empty alt for decorative images.",
            fix: "Add alt text that describes the image.",
          }),
          {
            ruleId: "nuxt-image/require-alt",
            severity: "error",
            category: "images",
          },
        );
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
    docsUrl: "https://image.nuxt.com/usage/nuxt-img#width-height",
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
        ctx.helpers.report(
          ctx,
          node,
          diagnostics.NUXT0008({
            why: "Nuxt images should declare dimensions or responsive sizes.",
            fix: "Add width/height for fixed images or sizes for responsive images.",
          }),
          {
            ruleId: "nuxt-image/prefer-responsive-dimensions",
            severity: "warn",
            category: "images",
          },
        );
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
    docsUrl: "https://image.nuxt.com/usage/nuxt-picture#format",
    requires: { template: true, nuxt: true },
  },
  create(ctx) {
    return {
      TemplateNode(node: AnyNode) {
        if (node.type !== "VElement" || node.rawName !== "NuxtImg") return;
        const format = ctx.helpers.getStaticVueAttributeValue(node, "format");
        if (!format || !/(webp|avif)/i.test(format)) return;
        ctx.helpers.report(
          ctx,
          node,
          diagnostics.NUXT0007({
            why: "Format negotiation is clearer with <NuxtPicture>.",
            fix: "Use <NuxtPicture> when serving modern formats with fallbacks.",
          }),
          {
            ruleId: "nuxt-image/prefer-nuxtpicture-for-formats",
            severity: "info",
            category: "images",
          },
        );
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

export const nuxtImageRulePack = defineRulePack({
  name: "vite-doctor/nuxt-image",
  version: "0.0.0",
  activation: { nuxt: ">=4", packages: ["@nuxt/image"], modules: ["@nuxt/image"] },
  rules,
  presets: { recommended: rules.map((rule) => rule.meta.id) },
});

export default nuxtImageRulePack;
