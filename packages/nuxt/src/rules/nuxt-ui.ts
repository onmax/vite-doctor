import { existsSync, readFileSync } from "node:fs";
import { join } from "pathe";
import { createRule, defineRulePack, type DoctorRule } from "@vue-doctor/core";
import { diagnostics } from "../diagnostics.js";

type AnyNode = any;

const TEXT_INPUT_TYPES = new Set(["text", "email", "password", "search", "url", "tel", "number"]);

export const requireUAppRoot = createRule({
  meta: {
    id: "nuxt-ui/require-uapp-root",
    title: "Use UApp when Nuxt UI app services are used",
    category: "ui",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://ui.nuxt.com/docs/components/app#usage",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    const usesAppService = /\b(useToast|useOverlay)\s*\(/.test(ctx.file.text);
    if (!usesAppService || projectHasUAppRoot(ctx.project.root) || /<\s*UApp\b/.test(ctx.file.text))
      return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Program") return;
        ctx.report(
          diagnostics.NUXT0015({
            why: "Nuxt UI toast and overlay services require a UApp root provider.",
            fix: "Wrap the app shell with <UApp> before using useToast() or useOverlay().",
          }),
          {
            ruleId: "nuxt-ui/require-uapp-root",
            severity: "warn",
            category: "ui",
            file: ctx.file.path,
            range: ctx.range(node),
          },
        );
      },
    };
  },
});

export const preferUButton = createRule({
  meta: {
    id: "nuxt-ui/prefer-u-button",
    title: "Use UButton for interactive buttons",
    category: "ui",
    severity: "info",
    fixable: "suggestion",
    docsUrl: "https://ui.nuxt.com/docs/components/button#usage",
    requires: { template: true, nuxt: true },
  },
  create(ctx) {
    return {
      TemplateNode(node: AnyNode) {
        if (node.type !== "VElement" || node.rawName !== "button" || hasDoctorIgnore(ctx, node))
          return;
        ctx.helpers.report(
          ctx,
          node,
          diagnostics.NUXT0013({
            why: "Native <button> reimplements behavior that Nuxt UI already provides.",
            fix: "Use <UButton> and map styling to Nuxt UI props such as icon, size, color, and variant.",
          }),
          {
            ruleId: "nuxt-ui/prefer-u-button",
            severity: "info",
            category: "ui",
          },
        );
      },
    };
  },
});

export const preferUFormControls = createRule({
  meta: {
    id: "nuxt-ui/prefer-u-form-controls",
    title: "Use Nuxt UI form controls",
    category: "ui",
    severity: "info",
    fixable: "suggestion",
    docsUrl: "https://ui.nuxt.com/docs/components/form#usage",
    requires: { template: true, nuxt: true },
  },
  create(ctx) {
    return {
      TemplateNode(node: AnyNode) {
        if (node.type !== "VElement" || hasDoctorIgnore(ctx, node)) return;
        const replacement = formControlReplacement(ctx, node);
        if (!replacement) return;
        ctx.helpers.report(
          ctx,
          node,
          diagnostics.NUXT0014({
            why: `Native <${node.rawName}> reimplements behavior that Nuxt UI already provides.`,
            fix: replacement,
          }),
          {
            ruleId: "nuxt-ui/prefer-u-form-controls",
            severity: "info",
            category: "ui",
          },
        );
      },
    };
  },
});

export const rules: DoctorRule[] = [requireUAppRoot, preferUButton, preferUFormControls];

export const nuxtUiRulePack = defineRulePack({
  name: "vite-doctor/nuxt-ui",
  version: "0.0.0",
  activation: { nuxt: ">=4", packages: ["@nuxt/ui"], modules: ["@nuxt/ui"] },
  rules,
  presets: { recommended: rules.map((rule) => rule.meta.id) },
});

export default nuxtUiRulePack;

function projectHasUAppRoot(root: string): boolean {
  return ["app/app.vue", "app.vue", "app/layouts/default.vue", "layouts/default.vue"].some(
    (file) => {
      const absolute = join(root, file);
      return existsSync(absolute) && /<\s*UApp\b/.test(readFileSync(absolute, "utf8"));
    },
  );
}

function hasDoctorIgnore(ctx: Parameters<DoctorRule["create"]>[0], node: AnyNode): boolean {
  return (
    ctx.helpers.hasVueAttribute(node, "data-doctor-ignore") ||
    ctx.helpers.hasVueDirective(node, "bind", "data-doctor-ignore")
  );
}

function formControlReplacement(
  ctx: Parameters<DoctorRule["create"]>[0],
  node: AnyNode,
): string | null {
  if (node.rawName === "textarea") return "Use <UTextarea> for multiline text input.";
  if (node.rawName === "select")
    return "Use <USelect> for simple option lists, or <USelectMenu> for richer option data.";
  if (node.rawName !== "input") return null;

  if (ctx.helpers.hasVueDirective(node, "bind", "type")) return null;
  const inputType = ctx.helpers.getStaticVueAttributeValue(node, "type")?.toLowerCase() ?? "text";
  if (!TEXT_INPUT_TYPES.has(inputType)) return null;
  return "Use <UInput> for text-like inputs. Use specialized Nuxt UI controls for checkbox, radio, switch, file, range, or other non-text inputs.";
}
