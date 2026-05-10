import { createRule, type DoctorRule, type RulePack } from "@vue-doctor/core";

type AnyNode = any;

export const preferUseWindowSize = createRule({
  meta: {
    id: "vueuse/prefer-usewindow-size",
    title: "Use useWindowSize for reactive viewport size",
    category: "hydration",
    severity: "info",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        const name = ctx.helpers.getNodeName(node);
        if (name !== "window.innerWidth" && name !== "window.innerHeight") return;
        if (ctx.helpers.isTypeOnlyContext(node)) return;
        if (ctx.helpers.isClientOnlyExecutionContext(node, ctx.file.text)) return;
        ctx.helpers.report(ctx, node, {
          ruleId: "vueuse/prefer-usewindow-size",
          severity: "info",
          category: "hydration",
          message: "Raw window size reads are not reactive and are browser-only.",
          suggestion: "Use VueUse useWindowSize() when @vueuse/core is installed.",
        });
      },
    };
  },
});

export const preferUseBreakpoints = createRule({
  meta: {
    id: "vueuse/prefer-usebreakpoints",
    title: "Use useBreakpoints for responsive state",
    category: "hydration",
    severity: "info",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        const name = ctx.helpers.getNodeName(node);
        if (name !== "window.matchMedia" && name !== "matchMedia") return;
        ctx.helpers.report(ctx, node, {
          ruleId: "vueuse/prefer-usebreakpoints",
          severity: "info",
          category: "hydration",
          message: "Raw media query reads are browser-only and not semantic app state.",
          suggestion: "Use VueUse useBreakpoints() for responsive state.",
        });
      },
    };
  },
});

export const preferUseClipboard = createRule({
  meta: {
    id: "vueuse/prefer-useclipboard",
    title: "Use useClipboard for clipboard access",
    category: "browser-api",
    severity: "info",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (ctx.helpers.getCalleeName(node) !== "navigator.clipboard.writeText") return;
        ctx.helpers.report(ctx, node, {
          ruleId: "vueuse/prefer-useclipboard",
          severity: "info",
          category: "browser-api",
          message: "Raw clipboard access is easier to model through a composable.",
          suggestion: "Use VueUse useClipboard() in event-driven client code.",
        });
      },
    };
  },
});

export const noVueUseNuxtAutoImportCollision = createRule({
  meta: {
    id: "vueuse/no-nuxt-auto-import-collision",
    title: "Avoid VueUse names that collide with Nuxt auto-imports",
    category: "imports",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    const colliding = new Set(["useFetch", "useCookie", "useHead", "useStorage", "useImage"]);
    return {
      ImportDeclaration(node: AnyNode) {
        if (node.source?.value !== "@vueuse/core" && node.source?.value !== "@vueuse/nuxt") return;
        for (const specifier of node.specifiers ?? []) {
          const name = specifier.imported?.name;
          if (!colliding.has(name)) continue;
          ctx.helpers.report(ctx, specifier, {
            ruleId: "vueuse/no-nuxt-auto-import-collision",
            severity: "warn",
            category: "imports",
            message: `${name} collides with a Nuxt built-in name.`,
            suggestion: `Alias the VueUse import, or prefer Nuxt's ${name} when you need Nuxt runtime semantics.`,
          });
        }
      },
    };
  },
});

export const rules: DoctorRule[] = [
  preferUseWindowSize,
  preferUseBreakpoints,
  preferUseClipboard,
  noVueUseNuxtAutoImportCollision,
];

export const vueUseRulePack: RulePack = {
  name: "nuxt-doctor/vueuse",
  version: "0.0.0",
  activation: { nuxt: ">=4", packages: ["@vueuse/core"] },
  rules,
  presets: { recommended: rules.map((rule) => rule.meta.id) },
};

export default vueUseRulePack;
