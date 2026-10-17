import { parseSync } from "oxc-parser";
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
const EXTENDS_ALIASES = ["~~", "@@", "~", "@"];

/** One Nuxt layer and its source directories, or a layer Doctor cannot read. */
type ShellLayer = { root: string; dirs: string[] } | "unresolved";

/** Statically readable layer options; `null` marks a value Doctor cannot evaluate. */
interface LayerConfig {
  srcDir: string | undefined | null;
  extends: string[] | null;
}

/**
 * True when the app shell Nuxt resolves across the project's layers renders UApp, or when a layer
 * or shell file that could supply it cannot be read, because a provider there would be invisible.
 */
function projectHasUAppRoot(ctx: RuleContext): boolean {
  const layers = shellLayers(ctx);
  // Nuxt takes each shell file from the highest-priority layer that has it.
  return SHELL_FILES.some((file) => {
    for (const layer of layers) {
      if (layer === "unresolved") return true;
      const path = layer.dirs
        .map((dir) => join(dir, file))
        .find((candidate) => ctx.fs.exists(candidate));
      if (!path) continue;
      const source = ctx.fs.readText(path);
      return source === undefined || hasUAppTemplate(source);
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
      .map((layer) => {
        const root = resolve(ctx.project.root, layer.root);
        if (!ctx.fs.exists(root)) return "unresolved";
        return { root, dirs: [resolve(ctx.project.root, layer.srcDir ?? layer.root)] };
      });
  return staticLayers(ctx.fs, resolve(ctx.project.root, resolved[0]?.root ?? "."));
}

/**
 * Nuxt's layer order without a manifest: the project, its `layers/*` (Z before A, but those named
 * in `extends` first and in that order), then the remaining `extends`. Each layer is followed by
 * the layers it extends.
 */
function staticLayers(fs: RuleFileSystem, projectRoot: string): ShellLayer[] {
  const layers: ShellLayer[] = [];
  const seen = new Set<string>();
  const visit = (root: string, config = readLayerConfig(fs, root)) => {
    if (seen.has(root)) return;
    seen.add(root);
    layers.push(shellLayer(root, config));
    for (const layer of extendedLayers(fs, projectRoot, root, config)) {
      if (layer) visit(layer);
      else layers.push("unresolved");
    }
  };
  const config = readLayerConfig(fs, projectRoot);
  seen.add(projectRoot);
  layers.push(shellLayer(projectRoot, config));
  const local = (fs.readDir(join(projectRoot, "layers")) ?? [])
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => join(projectRoot, "layers", entry.name))
    .sort((a, b) => b.localeCompare(a));
  for (const layer of local) visit(layer);
  const extended = extendedLayers(fs, projectRoot, projectRoot, config);
  for (const layer of extended) {
    if (layer) visit(layer);
    else layers.push("unresolved");
  }
  const listed = extended.filter((layer) => layer !== undefined);
  const slots = layers.flatMap((layer, index) =>
    layer !== "unresolved" && local.includes(layer.root) ? [index] : [],
  );
  const rank = (layer: ShellLayer) => {
    const index = layer === "unresolved" ? -1 : listed.indexOf(layer.root);
    return index === -1 ? Number.POSITIVE_INFINITY : index;
  };
  const ordered = slots.map((slot) => layers[slot]!).sort((a, b) => rank(a) - rank(b));
  slots.forEach((slot, index) => {
    layers[slot] = ordered[index]!;
  });
  return layers;
}

function shellLayer(root: string, config: LayerConfig | null): ShellLayer {
  if (!config || config.srcDir === null) return "unresolved";
  return { root, dirs: config.srcDir ? [resolve(root, config.srcDir)] : [join(root, "app"), root] };
}

/** Roots of the layers a config extends; an entry Doctor cannot resolve is `undefined`. */
function extendedLayers(
  fs: RuleFileSystem,
  projectRoot: string,
  root: string,
  config: LayerConfig | null,
): Array<string | undefined> {
  if (!config || !config.extends) return [undefined];
  return config.extends.map((entry) => resolveLayer(fs, projectRoot, root, entry));
}

function readLayerConfig(fs: RuleFileSystem, root: string): LayerConfig | null {
  for (const name of NUXT_CONFIG_FILES) {
    const file = join(root, name);
    const text = fs.readText(file);
    if (text === undefined) {
      if (fs.exists(file)) return null;
      continue;
    }
    const config = configObject(file, text);
    if (!config) return null;
    const srcDir = configOption(config, "srcDir");
    const extended = configOption(config, "extends");
    const entries: Array<string | null> =
      extended === undefined
        ? []
        : extended?.type === "ArrayExpression"
          ? extended.elements.map(stringValue)
          : [stringValue(extended)];
    return {
      srcDir: srcDir === undefined ? undefined : stringValue(srcDir),
      extends: entries.every((entry) => entry !== null) ? (entries as string[]) : null,
    };
  }
  return { srcDir: undefined, extends: [] };
}

/** The object passed to `defineNuxtConfig()` or exported directly. */
function configObject(file: string, text: string): AnyNode {
  let program: AnyNode;
  try {
    const parsed = parseSync(file, text, { sourceType: "module", lang: "ts" });
    if (parsed.errors.length) return null;
    program = parsed.program;
  } catch {
    return null;
  }
  for (const statement of program.body) {
    let node =
      statement.type === "ExportDefaultDeclaration"
        ? statement.declaration
        : statement.type === "ExpressionStatement" &&
            statement.expression.type === "AssignmentExpression" &&
            statement.expression.left.type === "MemberExpression" &&
            statement.expression.left.object?.name === "module" &&
            statement.expression.left.property?.name === "exports"
          ? statement.expression.right
          : undefined;
    if (!node) continue;
    while (
      ["TSAsExpression", "TSSatisfiesExpression", "ParenthesizedExpression"].includes(node.type)
    )
      node = node.expression;
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "defineNuxtConfig" &&
      node.arguments.length === 1
    )
      node = node.arguments[0];
    return node.type === "ObjectExpression" ? node : null;
  }
  return null;
}

/** A top-level option value, `undefined` when absent, or `null` when a spread could set it. */
function configOption(config: AnyNode, key: string): AnyNode {
  let value: AnyNode;
  let dynamic = false;
  for (const property of config.properties) {
    if (property.type !== "Property" || property.computed) {
      // A later spread or computed key may override an earlier explicit value.
      // Keep the option unresolved until a subsequent explicit assignment wins.
      value = undefined;
      dynamic = true;
    } else if ((property.key.name ?? property.key.value) === key) {
      value = property.value;
      dynamic = false;
    }
  }
  return value ?? (dynamic ? null : undefined);
}

function stringValue(node: AnyNode): string | null {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && !node.expressions.length)
    return node.quasis[0]?.value.cooked ?? null;
  return null;
}

function resolveLayer(
  fs: RuleFileSystem,
  projectRoot: string,
  root: string,
  entry: string,
): string | undefined {
  // Nuxt resolves these aliases in `extends` against the project root.
  const alias = EXTENDS_ALIASES.find((name) => entry === name || entry.startsWith(`${name}/`));
  const local = alias
    ? join(projectRoot, entry.slice(alias.length + 1))
    : entry.startsWith(".") || isAbsolute(entry)
      ? resolve(root, entry)
      : undefined;
  if (local) return fs.exists(local) ? local : undefined;
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
