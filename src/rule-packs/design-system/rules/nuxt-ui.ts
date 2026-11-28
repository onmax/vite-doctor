import { resolve } from "pathe";
import type { Node, Program } from "oxc-parser";
import type { RuleContext } from "../../../core/index.js";
import { parseScriptSync } from "../../../core/internal/script.js";
import { ownerRoot, ownerUses } from "./inventory.js";

const nuxtUiPackages = ["@nuxt/ui", "@nuxt/ui-pro"];

// Nuxt UI's default `theme.colors`. A configured list replaces it, though `primary` and `neutral`
// are always generated.
const defaultColors = ["primary", "secondary", "success", "info", "warning", "error"];
const alwaysColors = ["primary", "neutral"];
const shades = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"];

const borderTokens = ["default", "muted", "accented", "inverted", "bg"];
// The `@theme` Nuxt UI generates into `#build/ui.css`, by Tailwind color namespace.
const semanticTokens: Record<string, readonly string[]> = {
  text: ["dimmed", "muted", "toned", "default", "highlighted", "inverted"],
  background: ["default", "muted", "elevated", "accented", "inverted", "border"],
  border: borderTokens,
  ring: borderTokens,
  "ring-offset": borderTokens,
  divide: borderTokens,
  outline: ["default", "inverted"],
  stroke: ["bg", "default", "inverted"],
  fill: ["bg", "default", "inverted"],
};

const colorUtility =
  /^(ring-offset|inset-ring|inset-shadow|border-[xytrblse]|bg|text|border|ring|divide|outline|decoration|accent|caret|fill|stroke|shadow|from|via|to|placeholder)-(.+)$/;

const namespaceOf: Record<string, string> = { bg: "background", "inset-ring": "ring" };

/**
 * Nuxt UI's theme color names for the file's workspace package, or undefined when the package does
 * not use Nuxt UI. Nuxt UI declares its tokens in a stylesheet it generates at build time, so
 * @shadcn/lint cannot read them from the project's theme.
 */
export function nuxtUiColors(ctx: RuleContext): ReadonlySet<string> | undefined {
  const root = ownerRoot(ctx);
  const key = `design-system:nuxt-ui-colors:${root}`;
  const cached = ctx.cache.get<ReadonlySet<string> | null>(key);
  if (cached !== undefined) return cached ?? undefined;
  const colors = ownerUses(ctx, nuxtUiPackages)
    ? new Set([...alwaysColors, ...themeColors(ctx, resolve(ctx.project.root, root))])
    : null;
  ctx.cache.set(key, colors);
  return colors ?? undefined;
}

function themeColors(ctx: RuleContext, root: string): string[] {
  for (const base of ["nuxt.config", "vite.config"])
    for (const extension of ["ts", "mts", "js", "mjs"]) {
      const file = resolve(root, `${base}.${extension}`);
      const text = ctx.fs.readText(file);
      if (text == null) continue;
      const { program, errors } = parseScriptSync(file, text, { preserveParens: false });
      if (errors.length) return defaultColors;
      const options = uiOptions(program, base === "nuxt.config");
      const colors = configProperty(configProperty(options, "theme"), "colors");
      if (colors?.type !== "ArrayExpression" || !colors.elements.length) return defaultColors;
      const names: string[] = [];
      for (const item of colors.elements) {
        const name = staticString(unwrap(item ?? undefined));
        if (name === undefined || !/^[\w-]+$/.test(name)) return defaultColors;
        names.push(name);
      }
      return names;
    }
  return defaultColors;
}

function uiOptions(program: Program, nuxt: boolean): Node | undefined {
  const exported = unwrap(
    program.body.find((statement) => statement.type === "ExportDefaultDeclaration")?.declaration,
  );
  const helper = nuxt ? "defineNuxtConfig" : "defineConfig";
  const config = callArgument(exported, new Set([helper])) ?? exported;
  if (nuxt) return configProperty(config, "ui");
  const plugins = configProperty(config, "plugins");
  if (plugins?.type !== "ArrayExpression") return undefined;
  const bindings = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
    if (!nuxtUiPackages.some((name) => statement.source.value === `${name}/vite`)) continue;
    for (const specifier of statement.specifiers)
      if (specifier.type === "ImportDefaultSpecifier") bindings.add(specifier.local.name);
  }
  for (const plugin of plugins.elements) {
    const argument = callArgument(plugin ?? undefined, bindings);
    if (argument) return argument;
  }
  return undefined;
}

function callArgument(expression: Node | undefined, names: ReadonlySet<string>): Node | undefined {
  const call = unwrap(expression);
  if (
    call?.type === "CallExpression" &&
    !call.optional &&
    call.callee.type === "Identifier" &&
    names.has(call.callee.name)
  )
    return unwrap(call.arguments[0]);
  return undefined;
}

function configProperty(expression: Node | undefined, name: string): Node | undefined {
  const object = unwrap(expression);
  if (object?.type !== "ObjectExpression") return undefined;
  for (const property of object.properties.toReversed()) {
    if (property.type !== "Property") return undefined;
    const key = unwrap(property.key);
    const keyName =
      !property.computed && key?.type === "Identifier"
        ? key.name
        : key?.type === "Literal" && !("regex" in key)
          ? String(key.value)
          : staticString(key);
    if (keyName === undefined) return undefined;
    if (keyName === name) return property.kind === "init" ? unwrap(property.value) : undefined;
  }
  return undefined;
}

function unwrap(node: Node | undefined): Node | undefined {
  while (
    node?.type === "TSAsExpression" ||
    node?.type === "TSSatisfiesExpression" ||
    node?.type === "TSTypeAssertion" ||
    node?.type === "TSNonNullExpression"
  )
    node = node.expression;
  return node;
}

function staticString(node: Node | undefined): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

/** Whether a class uses a color token Nuxt UI declares, such as `text-muted` or `bg-primary/10`. */
export function isNuxtUiColorClass(className: string, colors: ReadonlySet<string>): boolean {
  const utility = className
    .slice(className.lastIndexOf(":") + 1)
    .replace(/^!|!$/g, "")
    .replace(/\/[^/]+$/, "");
  const match = colorUtility.exec(utility);
  if (!match) return false;
  const prefix = match[1]!;
  const value = match[2]!;
  if (colors.has(value)) return true;
  const shade = /^(.+)-(\d+)$/.exec(value);
  if (shade && colors.has(shade[1]!) && shades.includes(shade[2]!)) return true;
  const namespace = namespaceOf[prefix] ?? prefix.replace(/-[xytrblse]$/, "");
  return semanticTokens[namespace]?.includes(value) ?? false;
}
