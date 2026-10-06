import { TemplateNodeType } from "../../../../core/rule-authoring.js";
import { createRule, isClientOnlyPath, isNuxtRuntimeFile, report } from "./shared.js";

export const noClientConditionalInTemplate = createRule({
  meta: {
    id: "nuxt/hydration/no-client-conditional-in-template",
    title: "Avoid client-only conditionals in SSR templates",
    category: "hydration",
    severity: "warn",
    fixable: "suggestion",
    docsUrl:
      "https://nuxt.com/docs/4.x/guide/best-practices/hydration#conditional-rendering-based-on-client-state",
    requires: { template: true, nuxt: true },
  },
  create(ctx) {
    if (
      !isNuxtRuntimeFile(ctx) ||
      isClientOnlyPath(ctx.file.relativePath) ||
      ctx.helpers.isNuxtServerFile(ctx.file.relativePath)
    )
      return;
    return {
      template: {
        element(node) {
          const branchesOnClient = node.props.some(
            (prop) =>
              prop.type === TemplateNodeType.DIRECTIVE &&
              CONDITIONAL_DIRECTIVES.has(prop.name) &&
              /\b(import\.meta\.client|process\.client|window|document|navigator)\b/.test(
                prop.exp?.content ?? "",
              ),
          );
          if (!branchesOnClient) return;
          report(
            ctx,
            node,
            "nuxt/hydration/no-client-conditional-in-template",
            "warn",
            "hydration",
            "This template branches on client-only state during SSR and can hydrate to different markup.",
            "Prefer CSS breakpoints, <ClientOnly>, or initialize SSR-safe state before rendering.",
          );
        },
      },
    };
  },
});

const CONDITIONAL_DIRECTIVES = new Set(["if", "else-if", "show"]);
