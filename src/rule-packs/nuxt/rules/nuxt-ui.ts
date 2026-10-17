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

const SHELL_FILES = ["app.vue", "layouts/default.vue"];
const NUXT_CONFIG_FILES = ["ts", "mts", "cts", "js", "mjs", "cjs"].map(
  (extension) => `nuxt.config.${extension}`,
);

/** Source directories of one Nuxt layer, highest priority first, or a layer Doctor cannot read. */
type ShellLayer = string[] | "unresolved";

/**
 * True when the app shell Nuxt resolves across the project's layers renders UApp, or when a layer
 * that could supply the shell cannot be read, because a provider there would be invisible.
 */
function projectHasUAppRoot(ctx: RuleContext): boolean {
  const layers = shellLayers(ctx);
  // Nuxt takes each shell file from the highest-priority layer that has it.
  return SHELL_FILES.some((file) => {
    for (const layer of layers) {
      if (layer === "unresolved") return true;
      const path = layer
        .map((dir) => join(dir, file))
        .find((candidate) => ctx.fs.exists(candidate));
      if (path) return hasUAppTemplate(ctx.fs.readText(path));
    }
    return false;
  });
}

function shellLayers(ctx: RuleContext): ShellLayer[] {
  const resolved = ctx.project.nuxt?.layers ?? [];
  // Manifest layers come from Nuxt's own resolution, in priority order with their srcDir.
  if (resolved.some((layer) => layer.srcDir))
    return [...resolved]
      .sort((a, b) => a.priority - b.priority)
      .map((layer) =>
        ctx.fs.exists(resolve(ctx.project.root, layer.root))
          ? [resolve(ctx.project.root, layer.srcDir ?? layer.root)]
          : "unresolved",
      );
  const layers: ShellLayer[] = [];
  collectStaticLayers(
    ctx.fs,
    resolve(ctx.project.root, resolved[0]?.root ?? "."),
    layers,
    new Set(),
  );
  return layers;
}

/** Nuxt's layer order: the layer, its auto-registered `layers/*` (Z before A), then `extends`. */
function collectStaticLayers(
  fs: RuleFileSystem,
  root: string,
  layers: ShellLayer[],
  seen: Set<string>,
) {
  if (seen.has(root)) return;
  seen.add(root);
  const config = NUXT_CONFIG_FILES.map((file) => fs.readText(join(root, file))).find(
    (text) => text !== undefined,
  );
  const srcDir = configuredSrcDir(config);
  if (srcDir === null) layers.push("unresolved");
  else layers.push(srcDir ? [resolve(root, srcDir)] : [join(root, "app"), root]);
  const autoRegistered = (fs.readDir(join(root, "layers")) ?? [])
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const name of autoRegistered)
    collectStaticLayers(fs, join(root, "layers", name), layers, seen);
  const extended = extendedLayers(fs, root, config);
  if (!extended) {
    layers.push("unresolved");
    return;
  }
  for (const layer of extended) collectStaticLayers(fs, layer, layers, seen);
}

/** A literal srcDir, `undefined` when none is set, or `null` when it is computed. */
function configuredSrcDir(config: string | undefined): string | null | undefined {
  if (!config || !/\bsrcDir\s*:/.test(config)) return undefined;
  return config.match(/\bsrcDir\s*:\s*(["'`])([^"'`]+)\1/)?.[2] ?? null;
}

/** Local roots of the layers a Nuxt config extends, or `undefined` when one cannot be resolved. */
function extendedLayers(
  fs: RuleFileSystem,
  root: string,
  config: string | undefined,
): string[] | undefined {
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
