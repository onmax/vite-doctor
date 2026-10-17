import { dirname, isAbsolute, join, resolve } from "pathe";
import {
  createRule,
  defineRulePack,
  type DoctorRule,
  type RuleContext,
  type RuleFileSystem,
  type TemplateElementNode,
  type TemplateRootNode,
} from "../../../core/index.js";
import { loadVueCompilerSfc } from "../../../core/internal/lazy-parsers.js";
import { TemplateNodeType, walkTemplate } from "../../../core/rule-authoring.js";
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
    prefilter: { calls: ["useToast", "useOverlay"] },
  },
  create(ctx) {
    const usesAppService = /\b(useToast|useOverlay)\s*\(/.test(ctx.file.text);
    if (!usesAppService || projectHasUAppRoot(ctx) || hasUAppProvider(ctx.file.templateAst)) return;
    let reported = false;
    return {
      CallExpression(node: AnyNode) {
        if (
          reported ||
          (!ctx.helpers.isCall(node, "useToast") && !ctx.helpers.isCall(node, "useOverlay"))
        )
          return;
        reported = true;
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
      template: {
        element(node) {
          if (node.tag !== "button" || hasDoctorIgnore(ctx, node)) return;
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
      template: {
        element(node) {
          if (hasDoctorIgnore(ctx, node)) return;
          const replacement = formControlReplacement(ctx, node);
          if (!replacement) return;
          ctx.helpers.report(
            ctx,
            node,
            diagnostics.NUXT0014({
              why: `Native <${node.tag}> reimplements behavior that Nuxt UI already provides.`,
              fix: replacement,
            }),
            {
              ruleId: "nuxt-ui/prefer-u-form-controls",
              severity: "info",
              category: "ui",
            },
          );
        },
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

const SHELL_FILES = ["app/app.vue", "app.vue", "app/layouts/default.vue", "layouts/default.vue"];
const NUXT_CONFIG_FILES = [
  "nuxt.config.ts",
  "nuxt.config.js",
  "nuxt.config.mjs",
  "nuxt.config.mts",
];

/**
 * True when the app shell of the project or any Nuxt layer it extends renders UApp, or when an
 * extended layer cannot be read, because a provider there would be invisible to this check.
 */
function projectHasUAppRoot(ctx: RuleContext): boolean {
  const projectRoot = resolve(ctx.project.root, ctx.project.nuxt?.layers?.[0]?.root ?? ".");
  const roots = new Set([
    projectRoot,
    ...(ctx.project.nuxt?.layers ?? []).map((layer) => resolve(ctx.project.root, layer.root)),
  ]);
  for (const root of roots) if (layerHasUAppRoot(ctx.fs, root, new Set())) return true;
  return false;
}

function layerHasUAppRoot(fs: RuleFileSystem, root: string, seen: Set<string>): boolean {
  if (seen.has(root)) return false;
  seen.add(root);
  if (SHELL_FILES.some((file) => hasUAppTemplate(fs.readText(join(root, file))))) return true;
  const extended = extendedLayers(fs, root);
  if (!extended) return true;
  const autoRegistered = (fs.readDir(join(root, "layers")) ?? [])
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => join(root, "layers", entry.name));
  return [...extended, ...autoRegistered].some((layer) => layerHasUAppRoot(fs, layer, seen));
}

/** Local roots of the layers a Nuxt config extends, or `undefined` when one cannot be resolved. */
function extendedLayers(fs: RuleFileSystem, root: string): string[] | undefined {
  const config = NUXT_CONFIG_FILES.map((file) => fs.readText(join(root, file))).find(
    (text) => text !== undefined,
  );
  if (!config || !/\bextends\s*:/.test(config)) return [];
  const value = config.match(/\bextends\s*:\s*(\[[^\]]*\]|["'][^"']*["'])/)?.[1];
  if (!value) return undefined;
  const entries = [...value.matchAll(/["']([^"']*)["']/g)].map((match) => match[1]!);
  if (value.replace(/["'][^"']*["']|[\s,[\]]/g, "")) return undefined;
  const layers: string[] = [];
  for (const entry of entries) {
    const layer = resolveLayer(fs, root, entry);
    if (!layer) return undefined;
    layers.push(layer);
  }
  return layers;
}

function resolveLayer(fs: RuleFileSystem, root: string, entry: string): string | undefined {
  if (entry.startsWith(".") || isAbsolute(entry)) {
    const layer = resolve(root, entry);
    return fs.exists(layer) ? layer : undefined;
  }
  if (/^[a-z][\w+.-]*:/i.test(entry)) return undefined;
  for (let dir = root; ; dir = dirname(dir)) {
    const layer = join(dir, "node_modules", entry);
    if (fs.exists(join(layer, "package.json"))) return layer;
    if (dirname(dir) === dir) return undefined;
  }
}

function hasUAppTemplate(source: string | undefined): boolean {
  if (source === undefined) return false;
  return hasUAppProvider(
    loadVueCompilerSfc().parse(source).descriptor.template?.ast as TemplateRootNode | undefined,
  );
}

function hasUAppProvider(root: TemplateRootNode | null | undefined): boolean {
  let found = false;
  if (root)
    walkTemplate(root, (node) => {
      found ||=
        node.type === TemplateNodeType.ELEMENT &&
        node.tagType === 1 &&
        (node.tag === "UApp" || node.tag === "u-app");
    });
  return found;
}

function hasDoctorIgnore(ctx: RuleContext, node: TemplateElementNode): boolean {
  return (
    ctx.helpers.hasVueAttribute(node, "data-doctor-ignore") ||
    ctx.helpers.hasVueDirective(node, "bind", "data-doctor-ignore")
  );
}

function formControlReplacement(ctx: RuleContext, node: TemplateElementNode): string | null {
  if (node.tag === "textarea") return "Use <UTextarea> for multiline text input.";
  if (node.tag === "select")
    return "Use <USelect> for simple option lists, or <USelectMenu> for richer option data.";
  if (node.tag !== "input") return null;

  if (ctx.helpers.hasVueDirective(node, "bind", "type")) return null;
  const inputType = ctx.helpers.getStaticVueAttributeValue(node, "type")?.toLowerCase() ?? "text";
  if (!TEXT_INPUT_TYPES.has(inputType)) return null;
  return "Use <UInput> for text-like inputs. Use specialized Nuxt UI controls for checkbox, radio, switch, file, range, or other non-text inputs.";
}
